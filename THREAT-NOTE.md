# StockDesk — threat note (delivery chain)

**What we protect.** (1) The integrity of stock levels: next month suppliers will act on them, a wrong number
means wrong orders. (2) The credentials: DB password, API key, registry token, cluster access. (3) The shared
test cluster and the other teams' workloads on it. (4) The supply chain: what the registry serves is what the
cluster runs. (5) Corvane's credibility with suppliers.

**Who could attack.** Opportunistic Internet scanners (no account). Any of the ~40 repository readers, or
whoever phishes one of them — including the external contractor's account, which Corvane does not manage. The
departed contractor, who knows the setup and may keep access. A compromised upstream tool or action (the
`trivy-action` tag hijack of March 2026 is a recent real case). From next month, a supplier holding the API key.

## Attack paths and what cuts them

| # | Path | Cut by | What remains |
|---|---|---|---|
| A | **Pull request → pipeline.** Open a PR whose `package.json` adds a `pretest` script; `pull_request_target` runs it with `DEPLOY_TOKEN` and a `write-all` token, then pushes and deploys the PR's image. A PR title like `` `$(curl …)` `` does the same. | `pull_request` trigger (no secrets, read-only token); `permissions: {}`; event data only via `env`; publish/deploy only on `main`, in environments with approval. | A malicious change that passes a careless review. Branch protection and environments must actually be configured by an org admin. |
| B | **Network → debugger.** Reach port 9229 on the LoadBalancer (or on a test server running compose), attach the Node inspector, run code, read `process.env` → DB password and API key → database. | No `--inspect`, 9229 removed everywhere; Service limited to port 80 and to known source ranges; non-root, read-only container; NetworkPolicies limit what a compromised pod can reach. | The **old copy in namespace `default`** keeps its debugger (reachable inside the cluster) and the leaked credentials until an admin restarts it without `--inspect` and removes it after the cutover (runbook steps 0 and 4). Port 80 is still plain HTTP (API key in clear on the wire); source-range and NetworkPolicy enforcement depend on the provider/CNI (unverified). |
| C | **Leaked registry token → poisoned image.** Use `cvn_deploy_…` from the repo or old logs to push a new `stockdesk:latest`; the next pod restart pulls it. | Token removed from the repo, will be rotated (runbook); images tagged by commit SHA, scanned, archive hash checked, deployed **by digest** produced by the pipeline. | Until step 3 of the runbook is done the token is live. No signature check at admission: someone with cluster rights can still run another image. |
| D | **Deploy action / kubeconfig → whole cluster.** Whoever controls `corvane-labs/k8s-deploy-action@main` changes it and receives `KUBECONFIG` (likely cluster-admin) on the next push. | Third-party action removed (plain `kubectl`); every action pinned to a commit SHA; tools checked by SHA-256; new `ci-deployer` identity limited to one namespace (Deployment and ConfigMap only; no direct right on Secrets, Services, NetworkPolicies); kubeconfig only in the approved deploy job. | The old kubeconfig works until revoked (a client certificate may force a CA rotation). Whoever holds the new one can still change the pod template and so **read the namespace Secrets indirectly**: no admission policy yet restricts images or pod specs. |

## What remains overall, and what I recommend for suppliers

The rotation itself (only the owners can do it). One shared API key for everything, no per-supplier identity,
no rate limit, no audit log, product list readable without authentication — acceptable on a test cluster,
**not** for external suppliers. Before opening: run StockDesk in a **separate environment** (at least its own
namespace on a non-shared cluster), behind an **Ingress with TLS** (e.g. ingress-nginx + cert-manager, both free),
with a `ClusterIP` Service instead of a LoadBalancer, **one API key per supplier** (revocable, logged), rate
limiting at the ingress, and an audit log of stock adjustments. The shared test cluster should never be the
supplier entry point.
