# StockDesk delivery chain — prioritised risks

Scope: `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `k8s/`, `.env`, `.gitignore`, and the
parts of `src/` that affect delivery. Each risk gives: where it is, what could concretely happen, how serious it
is, and what I did about it (**Fixed**, **Reduced**, **Left**).

**Severity** = impact × likelihood, for the situation next month (API opened to external suppliers):
Critical (exploitable now with little effort, large impact), High, Medium, Low.

## Assumptions

- **Corvane's GitHub plan supports protected environments and branch protection** on this private repository.
  The pipeline's `environment: registry` / `test-cluster` only protect anything once an org admin has created them
  with branch rules and required reviewers; this was not verifiable. Fallback if the plan does not allow it: remove
  the automatic `deploy` job and let a cluster admin deploy the published digest by hand.
- **The secrets in the repository are live production values, and they are compromised.** Nobody can prove they
  were only used for tests; the `.env` says "production settings (copied from the ops wiki)" and the password is
  named `Sd-prod-2024-…`. About forty people (including an external contractor) can read the repository, so the
  values are in their clones, in forks, in old CI logs and in every image built since `COPY . .` was added. Being
  wrong costs one rotation; assuming "test only" and being wrong costs the data.
- **The KUBECONFIG secret has cluster-admin rights** on the shared cluster (nobody checked; the contractor who
  created it has left). I assume the worst until a cluster admin checks.
- **The LoadBalancer Service may be reachable from the Internet** (nobody checked).
- **Anyone of the ~40 readers can open a pull request** (confirmed), including from a fork inside the
  organisation. Their accounts can be phished; the contractor's account is outside Corvane's control.
- `corvane-labs/k8s-deploy-action` is **not** clearly controlled by Corvane today (different organisation name,
  set up by the departed contractor). I treat it as third-party code.
- Suppliers will reach StockDesk through a separate environment with TLS in front (my recommendation, see
  THREAT-NOTE.md), **not** through the shared test cluster.

## Summary table

| # | Risk | Where | Severity | Status |
|---|---|---|---|---|
| 1 | Secrets committed in clear and spread (repo, history, CI logs, image layers) | `.env`, `k8s/secret.yaml`, `docker-compose.yml`, `ci.yml` (`DEPLOY_TOKEN`) | Critical | **Reduced** (removed, scan added) — **rotation left to owners**, see runbook |
| 2 | "Pwn request": PR code runs with secrets and a `write-all` token, and gets built, pushed and deployed | `ci.yml`: `pull_request_target` + checkout of PR head, `permissions: write-all`, env `DEPLOY_TOKEN`, deploy without condition | Critical | **Fixed** |
| 3 | Node.js inspector open to the network = remote code execution | `Dockerfile` `--inspect=0.0.0.0:9229`, `EXPOSE 9229`; Service port 9229 on a LoadBalancer; compose `9229:9229` | Critical | **Fixed** |
| 3b | The old deployment keeps running in namespace `default` after the new one is deployed in `stockdesk`: its process still starts with `--inspect=0.0.0.0:9229` (removing the port from its Service does not stop the debugger, reachable from inside the cluster), it still accepts the leaked API key and DB password, and clients still use its IP | cluster | Critical | **Left** to cluster admin: runbook step 0 (disable the debugger in the old pod now) and step 4 (planned cutover, then removal); README checklist |
| 4 | Cluster credentials of unknown (likely admin) scope handed to an unpinned third-party action on `@main` | `ci.yml` deploy job, `secrets.KUBECONFIG` | Critical | **Fixed** in pipeline, **Reduced** overall (old credential must be revoked) |
| 4b | The CI deployer can read the namespace Secrets **indirectly**: it has no `get secrets`, but it can change the Deployment's pod template (another image, `envFrom: secretRef: stockdesk-env`) and run code that reads them | `k8s/admin/ci-deployer-rbac.yaml` | Medium (high impact, needs the deploy credential or an approved malicious deploy) | **Reduced**: human approval on the deploy job; ServiceAccount verbs removed; Pod Security "restricted" blocks privileged / host pods; NetworkPolicies limit egress (5432 still open to any address until the DB address is known). **Left**: admission policy (e.g. built-in ValidatingAdmissionPolicy, or Kyverno) allowing only `registry.corvane.example` images by digest and the `stockdesk` ServiceAccount |
| 5 | Unknown, unverified code in production: `:latest` everywhere, tests that cannot fail, no scan, any branch deploys | `ci.yml` (`npm test \|\| true`, `push: "**"`), `Dockerfile` `node:latest`, deployment `:latest` + `IfNotPresent` | High | **Fixed** |
| 6 | Secrets baked into the image (`COPY . .` with no `.dockerignore`: `.env`, `k8s/secret.yaml`, `.git`) | `Dockerfile` | High | **Fixed** for new images; **old images left** (delete, runbook step 6) |
| 7 | Secrets printed in application logs at startup | `src/server.js` `console.log(... JSON.stringify(config))` | High | **Fixed** |
| 8 | Script injection through the PR title | `ci.yml` "Announce build" step | High (Critical in combination with 2) | **Fixed** |
| 9 | Container runs as root, writable filesystem, default namespace, SA token mounted, no limits | `Dockerfile`, `k8s/deployment.yaml` | High | **Fixed** |
| 10 | Service exposure unknown, plain HTTP, API key sent in clear | `k8s` Service `type: LoadBalancer` | High | **Reduced** (source ranges, 1 port, no TLS yet) |
| 11 | No GitHub guard-rails: no branch protection, no CODEOWNERS, no environment approval | GitHub settings (outside the repo) | High | **Reduced** (environments with approval in the pipeline) — branch protection and mandatory review of `.github/`, `k8s/`, `Dockerfile` (e.g. CODEOWNERS with a real team) **left** to the org admin |
| 12 | Departed contractor may still hold access (GitHub, registry, cluster, `corvane-labs`) | Organisation | High | **Left** (runbook step 0) |
| 13 | No network isolation in a shared cluster (lateral movement, free egress) | `k8s/` | Medium | **Reduced**: default deny + allow-list. **Remaining**: egress on TCP 5432 is allowed to *any* address (the rule fixes the port, not the server) until the database location is known; enforcement depends on the CNI (unverified) |
| 13b | Moving the app to namespace `stockdesk` would break `DB_HOST=db` (a short DNS name resolves in the pod's own namespace) | `k8s/deployment.yaml` ConfigMap | High (availability: the pod would never become ready) | **Reduced**: `DB_HOST=db.default.svc`, same target as before **if** the database is the Service `db` in `default` (the repo does not define it). Unverified: that Service exists, and no NetworkPolicy on the database side blocks namespace `stockdesk`. Checks in the README cluster checklist |
| 14 | Liveness probe depends on the database, with a timeout equal to the DB check → restart loops | `k8s/deployment.yaml` | Medium (availability) | **Fixed** (`/livez` + readiness on `/health`) |
| 15 | Dev stack used on a "test server": Postgres published on all interfaces with the known password, `postgres:latest`, debugger | `docker-compose.yml` | Medium | **Fixed** in the file; **left**: check whether a test server still runs it |
| 16 | One shared API key for every writer, no per-supplier identity, no rate limit, no audit trail; product list readable without auth | `src/server.js` (design) | Medium now, **High once suppliers connect** | **Left** (recommendation) |
| 17 | Unbounded request body (memory exhaustion) | `src/server.js` POST adjust | Medium | **Fixed** (16 KiB, 413) |
| 18 | Scanners and actions are themselves a supply-chain risk | `ci.yml` | Medium | **Reduced** (SHA pins, SHA-256 checks, no secrets where they run) |
| 19 | No image signature / admission control: the cluster runs any image it is given | cluster | Medium | **Left** |
| 20 | No evidence to know if the leak was already exploited (no k8s audit, no app audit log) | cluster, app | Medium | **Left** (runbook investigation steps) |
| 21 | Node does not handle SIGTERM as PID 1 → 30 s hard kills on each rollout | `src/server.js` | Low | **Fixed** |
| 22 | API key compared with `!==` (timing side channel) | `src/server.js` | Low | **Fixed** |
| 23 | Single replica, in-memory stock, no PodDisruptionBudget; the old `RollingUpdate` (`maxSurge: 1`) briefly ran two pods with two different stocks during a deploy | `k8s/deployment.yaml`, `src/` | Medium for an inventory system | **Reduced**: strategy `Recreate` (no overlap, at the cost of a short outage per deploy). **Left**: every restart resets stock to the seed values; fix = keep stock in PostgreSQL, then 2+ replicas, RollingUpdate and a PodDisruptionBudget |
| 24 | Base image and Postgres digests not pinned | `Dockerfile`, `docker-compose.yml` | Low | **Left** (TODO verify; Dependabot maintains the Dockerfile base image once pinned; the local-only Postgres image is not tracked) |

## Why this order (top five)

1. **Secrets (1)** come first because the damage is not hypothetical: the values are *already* out, in places
   we cannot recall (40 clones, forks, logs, images). Every other fix protects the future; this one is the only
   risk that may already be in use by someone, and the leaked registry token alone lets anyone replace the image
   the cluster runs. It is also the only top risk I cannot fix myself, so it needs owners and a date.
2. **Pwn request (2)** is next because it is a standing, one-click path from "can open a PR" (40 people, one of
   them external) to: stealing the registry token and a `write-all` GitHub token, and getting arbitrary code
   built, pushed as `latest` and deployed — with no review at all. It would also re-leak any rotated secret, so it
   must be closed *before* rotation (runbook step 1).
3. **Inspector (3)** needs no account at all, only network reach, and gives full code execution in the pod (read
   `process.env` → DB password and API key). If the LoadBalancer is public, Internet scanners look for 9229. I rank
   it after 2 only because reachability is unknown, while 2 is certain for 40 people.
4. **KUBECONFIG + `@main` action (4)**: whoever controls `corvane-labs/k8s-deploy-action` (possibly the departed
   contractor) can change it at any time and receive the kubeconfig on the next push — likely admin of a cluster
   *shared with other teams*. Impact is the largest of all; it is fourth because exploitation needs control of that
   repository, which is less likely than 2 or 3.
5. **Unverified images (5)**: not an attack by itself, but it is what turns 1, 2 and 4 into silent compromise:
   with `:latest` + `IfNotPresent` nobody can say which code runs, a poisoned `latest` is picked up on the next pod
   restart, and failing tests never stop a deploy. Fixing it (deploy by digest from a gated pipeline) is also what
   makes rollback and audit possible.

## What I changed (by risk)

- **1**: `.env` and `k8s/secret.yaml` deleted from the tree; `.gitignore` now ignores `.env*` and
  `k8s/**/secret*.yaml`; `.env.example` and `k8s/admin/secret.example.yaml` hold placeholders only; compose reads
  the password from `.env`; the deploy token is a GitHub *environment* secret. gitleaks runs on every PR/push with
  custom rules — the default rules **missed** `cvn_deploy_…` in the old `ci.yml` (checked on the original commit). Every commit of a PR or push is scanned; on a first push or after a history rewrite the whole history is scanned,
  so the scan stays red until the original exposed values are removed from history (runbook step 7).
- **2**: trigger is `pull_request` (no secrets, read-only token, even for forks) + `push` to `main` only;
  `permissions: {}` then `contents: read` per job; `persist-credentials: false`; publish/deploy run only on `main`,
  in GitHub environments (`registry`, `test-cluster` with required reviewers), and run no code from the PR.
- **3**: no `--inspect` in the image, no 9229 in `EXPOSE`, Deployment or Service; debugging is an opt-in compose
  override bound to `127.0.0.1`.
- **4**: third-party action removed; `kubectl apply -k` with a kubeconfig written with `umask 077` and deleted
  after; new identity `ci-deployer` limited to namespace `stockdesk` (Deployment and ConfigMap only; no direct
  right on Secrets, ServiceAccounts, Services or NetworkPolicies) in `k8s/admin/ci-deployer-rbac.yaml`, token
  revocable by deleting a Secret. This is much smaller than cluster-admin, but **not** "no access to Secrets":
  see 4b.
- **4b**: runtime ServiceAccount moved to `k8s/admin/serviceaccount.yaml` and the `serviceaccounts` verbs removed
  from the CI role. The rest is documented, not solved (see the risk below).
- **5**: tests gate the pipeline; Node 24 LTS; image tagged with the commit SHA, scanned (Trivy, fails on fixable
  HIGH/CRITICAL), SBOM (CycloneDX) produced, archive hash checked between jobs, deployed **by digest**; the
  manifest's placeholder tag `pinned-by-ci` makes a manual apply fail instead of pulling `latest`.
- **6–9**: `.dockerignore`, explicit `COPY`; redacted startup log (+ test); PR title no longer used; non-root uid
  10001, read-only root FS with an `emptyDir` for `/tmp` (the app writes a marker file there), `drop: ALL`,
  `seccomp: RuntimeDefault`, no SA token, requests/limits, namespace `stockdesk` with Pod Security "restricted".
- **10, 13**: Service keeps `LoadBalancer` (internal users keep access) but only port 80 and
  `loadBalancerSourceRanges` (example range, **TODO** real office/VPN ranges); default-deny NetworkPolicy plus an
  allow-list (ingress 3000, egress DNS and TCP 5432 to any address for now: see #13). Both are in `k8s/admin/`, applied by an admin, so a stolen CI
  credential cannot reopen the network.
- **14, 17, 21, 22**: `/livez` route (+ test), body limit (+ test), SIGTERM handler, constant-time key comparison.
- **11, 18**: actions pinned to full commit SHAs (looked up
  with `git ls-remote` on 2026-11-19); tools downloaded from GitHub releases and checked against **hard-coded**
  SHA-256 values. Those values were compared with each release's own checksum file, which is the same source, so
  they prove CI runs the bytes I pinned, not that the release was clean. I dropped hadolint: Trivy already checks
  the Dockerfile's security settings, and hadolint's hash could not be checked against any published file. For Trivy I also verified the Sigstore signature with cosign: it was signed by Trivy's own
  release workflow, which proves origin but not that this workflow was safe. I do **not** use
  `aquasecurity/trivy-action`: its tags were force-pushed to a credential stealer in March 2026 (CVE-2026-33634).
  Pinning, fixed hashes and secret-free scan jobs **reduce** this kind of risk; they do not rule it out.
  Dependabot (actions and Docker base image) with a 7-day cooldown.

## Secrets already exposed — what must be done, in which order, by whom

I have no access to any of these systems; this is the plan for the people who do. Roles, not names: **CTO**
(incident owner), **GitHub org admin**, **cluster admin**, **registry admin**, **DB admin**, **StockDesk owner**.
Target: steps 0–4d on the same day; the CTO decides at step 4 whether the leaked DB password and API key are revoked at once (outage) or at the cutover.

**Why this order:** close the doors first (otherwise new secrets leak the same way), then rotate from the widest
blast radius to the narrowest. Rotating the API key while someone still holds cluster-admin is useless: they
would read the new Secret. History is cleaned **last**, because rewriting it does not un-leak anything.

| Step | Who | What |
|---|---|---|
| 0. Contain | CTO + GitHub org admin + cluster admin | Treat it as an incident (write down times and actions). **Disable GitHub Actions on the repository** until step 1 is merged (stops the pwn request and the `@main` action). Review open PRs and recent workflow runs. **Cluster admin, old copy in `default`:** remove port 9229 from its Service **and** restart it without the debugger (override the command to `node src/server.js`; commands in the README checklist, step 0), then check that `--inspect` is gone from the running process. Removing the Service port alone leaves the debugger reachable from inside the cluster. Cost: a short interruption, and the in-memory stock resets. Remove the departed contractor from the org, outside collaborators, deploy keys, GitHub Apps and PATs they created; check who controls the `corvane-labs` organisation. |
| 1. Merge the new pipeline | GitHub org admin + one reviewer | Branch protection on `main` (PR + 1 review + required checks `Unit tests`, `Secrets, Dockerfile…`, `Build and scan image`); default workflow token = read-only; approval required for fork pull request workflows; create environments `registry` (branch `main` only) and `test-cluster` (branch `main`, required reviewers). Delete repository-level `KUBECONFIG`. Then re-enable Actions. |
| 2. KUBECONFIG | Cluster admin | Find what it is (`kubectl auth can-i --list` with it). **Token** → delete the token / ServiceAccount. **Client certificate** → it cannot be revoked: remove its RoleBindings/ClusterRoleBindings; if its group is `system:masters`, bindings cannot be removed and the cluster CA must be rotated (plan it with the other teams of the shared cluster). Apply `k8s/admin/` (namespace, `ci-deployer`, Service, NetworkPolicies), build a kubeconfig from `ci-deployer-token`, store it as `KUBECONFIG` in environment `test-cluster`. Look for anything unexpected: new (Cluster)RoleBindings, pods/DaemonSets in any namespace, recently created ServiceAccounts. |
| 3. Registry token (`DEPLOY_TOKEN`) | Registry admin | Revoke `cvn_deploy_…`. Create a robot account that can only push `stockdesk`, store it as `REGISTRY_USER` / `REGISTRY_TOKEN` in environment `registry`. Review push history since the token was created; turn on tag immutability if the registry supports it. |
| 4. Decide the timing | **CTO** | The old deployment uses the **same** DB password and API key as the leak. Revoking them breaks it at once, so this is a choice between containment and availability. **Planned (default):** keep the old values valid for a few hours, do 4a–4d the same day, revoke at the cutover. **Emergency** (signs of misuse in step 2/3/5, or the DB is reachable from outside): revoke now and accept an outage until 4b is done. Write the decision down. |
| 4a. Prepare new values | DB admin + StockDesk owner + cluster admin | Check **where** the DB password is used (prod DB? test DB? reused elsewhere? the ops wiki it came from). For the database, prefer a **second role** (e.g. `stockdesk_app`, same grants, new random password; set `DB_USER` in the ConfigMap): old and new run side by side and the old one is closed at the cutover with no outage. If a second role is not possible, the password change itself happens at 4d. New API key: `openssl rand -hex 32`. Create the Secret `stockdesk-env` in `stockdesk` with the **new** values only (command in `k8s/admin/secret.example.yaml`). Remove the values from the ops wiki. |
| 4b. Deploy and check the new version | Cluster admin | First deploy through the pipeline, then README checklist step 4 (pod ready, `/health` 200, allowed / refused networks, 9229 closed). |
| 4c. Move the clients | StockDesk owner | Give every known client the new endpoint **and** the new API key, preferably through a stable DNS name Corvane controls (e.g. `stockdesk.internal.corvane.example` → new LoadBalancer), so the next change of IP is a DNS change. Scripts may have the old IP hard-coded: confirm each known client works on the new endpoint, then watch the old one (LoadBalancer metrics, or the old pod logs) until legitimate traffic stops. Nobody knows who has the old key: unknown users will appear as 401s on the new endpoint. |
| 4d. Revoke and remove the old copy | DB admin + cluster admin | Revoke the old DB credential (`ALTER ROLE stockdesk NOLOGIN` if a second role was created, otherwise `ALTER ROLE stockdesk PASSWORD '…'` and update the new Secret, then `kubectl -n stockdesk rollout restart deployment/stockdesk`). Delete the old copy: `kubectl -n default delete deployment/stockdesk service/stockdesk secret/stockdesk-env`; the old API key disappears with it. Check PostgreSQL logs for connections from unknown addresses. Compare stock levels with a physical/ERP count: there is no audit log of adjustments. |
| 5. Find old exposure | GitHub org admin | Delete old Actions run logs: `DEPLOY_TOKEN` was a plain env value, so it was **not masked** and was printed by `echo "Logging in with token $DEPLOY_TOKEN"`. Check the audit log for actions by `github-actions[bot]` (pushes, tags, releases, new workflows) made with the `write-all` token. |
| 6. Old images | Registry admin | After the new image is deployed, delete every image built by the old pipeline: their layers contain `.env` and `k8s/secret.yaml`. |
| 7. Clean history (hygiene) | GitHub org admin | `git filter-repo` to remove `.env`, `k8s/secret.yaml` and the token line, force-push, ask everyone to re-clone, ask GitHub Support to purge cached refs. Forks and existing clones keep the old values: this is why rotation came first. |
| 8. Prevent | Everyone | gitleaks in CI (done); optional pre-commit hook; GitHub push protection / secret scanning if the plan includes it; keep the secret values in a shared password manager, not a wiki. |

`GITHUB_TOKEN` itself needs no rotation (it expires at the end of each job), but what it did must be checked (step 5).
