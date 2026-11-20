# StockDesk — threat note (delivery chain)

**What we protect.** (1) The integrity of stock levels: next month suppliers will act on them. (2) The
credentials: DB password, API key, registry token, cluster access. (3) The shared test cluster and the other
teams' workloads on it. (4) The supply chain: what the registry serves is what the cluster runs. (5) Corvane's
credibility with suppliers.

**Who could attack.** Internet scanners (no account). Any of the ~40 repository readers, or whoever phishes one of
them, including the external contractor's account. The departed contractor, who knows the setup and whose access to
the deploy action was never revoked. A compromised upstream tool (the `trivy-action` tag hijack of
March 2026 is a real case). From next month, a supplier, or anyone holding a supplier's key.

## Attack paths and what cuts them

| # | Path | Cut by | What remains |
|---|---|---|---|
| A | **Pull request → pipeline.** A PR adds a `pretest` script; `pull_request_target` runs it with `DEPLOY_TOKEN` and a `write-all` token, then pushes and deploys the PR's image. A crafted PR title does the same. | `pull_request` trigger (no secrets, read-only token); `permissions: {}`; event data only via `env`; publish/deploy only from `main`, in environments with approval. | A malicious change that passes a careless review. Branch protection and environments must be configured by an org admin. |
| B | **Network → debugger.** Reach port 9229 on the LoadBalancer, or on the shared test server where the compose stack still runs (if it uses the original file); attach the Node inspector, run code, read `process.env` → DB password and API key → database. | No `--inspect`, 9229 removed everywhere; Service limited to port 80 and known source ranges; non-root, read-only container; NetworkPolicies limit what a compromised pod reaches. | The **running copies** (old pod in `default`, compose stack on the test server) keep the debugger and the leaked credentials until an admin acts (runbook steps 0 and 4). Port 80 is plain HTTP; source-range and NetworkPolicy enforcement are unverified. |
| C | **Leaked registry token → poisoned image.** Use `cvn_deploy_…` from the repo or old logs to push a new `stockdesk:latest`; the next pod restart pulls it. | Token removed from the repo, to be rotated; images tagged by commit SHA, scanned, archive hash checked, deployed **by digest**. | The token is live until runbook step 3. No signature check at admission. |
| D | **Deploy action / kubeconfig → whole cluster.** Whoever can push to `corvane-labs/k8s-deploy-action@main` (possibly the departed contractor, whose access was never revoked) changes it and receives `KUBECONFIG` (likely cluster-admin) on the next push. | Action no longer used (plain `kubectl`); actions pinned to commit SHAs; tools checked by SHA-256; `ci-deployer` identity limited to one namespace (Deployment and ConfigMap only), only in the approved deploy job. | The old kubeconfig works until revoked; the contractor's access must be removed and the action's history reviewed. The new identity can still **read the namespace Secrets indirectly** by changing the pod template (no admission policy yet). |

## What remains overall, and what I recommend for suppliers

The rotation and cutover (only the owners can do them). One shared API key, no per-supplier identity, no rate
limit, no audit log, product list readable without authentication. These are **existing residual risks**, not accepted
as safe because the cluster is "for tests": it is shared and may already be reachable by unauthorized people. **My recommendation to the CTO:** suppliers **read only**, with **one revocable key per supplier**,
limited to their own products if needed; adjustments stay internal. If suppliers may also adjust stock, that
becomes the first fix before opening, with an audit log (RISKS.md #16). Either way, suppliers should come through a
**separate environment** (not the shared test cluster), behind an **Ingress with TLS** (e.g. ingress-nginx +
cert-manager, both free), with a `ClusterIP` Service and rate limiting at the ingress.
