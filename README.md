# StockDesk — hardened delivery chain

Corvane's small stock-tracking API (Node.js 18+, no dependency), with its delivery chain reviewed and hardened
before the API is opened to external suppliers.

**Status:** locally validated hardening with operational prerequisites (GitHub settings, cluster setup, secret
rotation). Not deployed, and the pipeline has never run on GitHub.

**Read in this order:** `RISKS.md` (prioritised risks + what to do about the secrets already exposed) →
`THREAT-NOTE.md` (one page). The one-page design note and the AI statement are in the submission form.

The Git history has two parts: the **first commit is the repository exactly as received** (including the
fictional exposed values, kept on purpose so the diff is readable); the following commits are my changes.

```
git log --oneline
git diff <first-commit> HEAD --stat
```

## What is where

| Path | What it is |
|---|---|
| `.github/workflows/ci.yml` | Pipeline: tests, secret scan, linters, manifest validation, image build + scan + SBOM on every PR; push and deploy by digest from `main` only, through approved environments. |
| `.github/scripts/install-tools.sh` | Downloads pinned scanner versions and checks their SHA-256. |
| `.github/dependabot.yml` | Automatic update PRs for the pinned actions and the Docker base image. |
| `.gitleaks.toml`, `.trivyignore.yaml` | Secret-scan rules (incl. Corvane token formats); reviewed and justified Trivy exceptions. |
| `Dockerfile`, `.dockerignore` | Node 24 LTS slim, explicit copy, non-root, no debugger. |
| `docker-compose.yml`, `docker-compose.debug.yml`, `.env.example` | Local development only; ports on 127.0.0.1; debugger is opt-in. |
| `k8s/deployment.yaml`, `k8s/kustomization.yaml` | What CI applies: ConfigMap and Deployment (namespace `stockdesk`). |
| `k8s/admin/` | Applied **once by a cluster admin, never by CI**: namespace (Pod Security "restricted"), runtime ServiceAccount, CI identity + RBAC, Service, NetworkPolicies, Secret example. |
| `src/`, `test/` | App: redacted startup log, `/livez`, body limit, constant-time key check, SIGTERM; 10 tests (5 original + 5 new). |

## Run and test

Requires Node.js 18 or later.

```
npm test                    # 10 tests
node src/server.js          # listens on 3000; /livez, /health, /api/products
```

Local stack (Docker):

```
cp .env.example .env        # edit the values; .env is git-ignored
docker compose up --build
docker compose -f docker-compose.yml -f docker-compose.debug.yml up   # with the Node inspector on 127.0.0.1:9229
```

Check the YAML:

```
python3 -c "import sys, yaml; [list(yaml.safe_load_all(open(f))) for f in sys.argv[1:]]; print('YAML ok')" \
  k8s/*.yaml k8s/admin/*.yaml .github/workflows/ci.yml .github/dependabot.yml docker-compose*.yml .trivyignore.yaml
```

## What was checked, and how

Unless marked otherwise, these checks were run on 2026-11-19/20 in the Linux environment used to prepare the files
(not on GitHub, not on a cluster). Re-run on my own PC: `npm test` and the YAML parse.

| Check | Result |
|---|---|
| `npm test` (Node 22.23 locally) | 10/10 pass, run several times. |
| YAML parse (command above) | OK for every YAML file. |
| `actionlint` 1.7.12 on the workflow | No finding (the original had one: PR title injection). |
| `zizmor` 1.32.0, `--offline --persona=pedantic`, on `.github/` | No finding (the original: dangerous trigger, excessive permissions, 2 template injections, 4 unpinned actions, 2 credential persistence). |
| `hadolint` 2.15.1 on `Dockerfile` (local check only; not in CI, where Trivy covers the Dockerfile) | No finding. |
| `kubeconform` 0.8.0 `-strict` on `k8s/` and `k8s/admin/` | 12 valid resources (Kustomization skipped). |
| `kustomize` 5.8.3: the deploy step's overlay, extracted from `ci.yml` and run with a fake digest | Renders 2 objects in namespace `stockdesk`, image `…/stockdesk@sha256:…`; passes kubeconform; a malformed digest is rejected. |
| `trivy` 0.76.2 `config` with `.trivyignore.yaml`, MEDIUM+ | Exit 0 (the original: root user, default security context, writable root FS). Remaining exceptions are listed with reasons. |
| `gitleaks` 8.30.1 with `.gitleaks.toml` | Current tree: no leak. History: finds all exposed values of the first commit, including the deploy token that the **default rules missed**. |
| `docker compose config` | Valid; ports bound to 127.0.0.1; refuses to start without `DB_PASSWORD`. |
| Build context | Built a `FROM scratch` image that copies the context: only `package*.json`, `src/`, `.env.example`, `.gitignore` enter (no `.env`, `.git`, `k8s/`). |
| App smoke test | Startup log shows `dbPasswordSet: true` but not the value; `/livez` 200 with no database; SIGTERM → clean exit 0. |
| Action commit SHAs, tool hashes | SHAs from `git ls-remote` on 2026-11-19; tool SHA-256 hard-coded and compared with each release's checksum file, i.e. the same source. Trivy: Sigstore signature verified with cosign 2.6.5 (signed by Trivy's release workflow). Signatures of the other tools not checked. |

**Not checked:**
- I did **not** run `docker build` with the real base image: my environment could not reach Docker Hub. So the
  image itself, the `HEALTHCHECK`, the `npm ci` step and the Trivy image scan were not run.
- Node **24** was not tested (tests ran on Node 22).
- The pipeline never ran on GitHub (as expected). Not verified: `kubectl` presence/version on `ubuntu-24.04`
  runners, `docker inspect` returning `RepoDigests` after push with the runner's Docker version.
- Nothing ran against a cluster: Pod Security "restricted" admission, `loadBalancerSourceRanges` and NetworkPolicy
  enforcement (CNI) are unverified.
- Base image and Postgres digests are **not pinned** (TODO verify in `Dockerfile` / compose).

## Setup outside the repository (needed for the pipeline to be safe)

### GitHub (org admin)

 branch protection on `main` (PR, 1 approval, required checks; optionally a CODEOWNERS file with a real team for `.github/`, `k8s/`, `Dockerfile`); default workflow
token read-only; approval required for fork PR workflows; environments `registry` (secrets `REGISTRY_USER`,
`REGISTRY_TOKEN`; branch `main`) and `test-cluster` (secret `KUBECONFIG`; branch `main`; required reviewers).

### Cluster checklist (cluster admin, once)

The new version runs in its own namespace `stockdesk` and gets a **new** LoadBalancer IP. **The old one keeps
running in `default`**, with the debugger, the leaked credentials and its current users, until it is removed:
step 0 and step 5 below deal with that.

**0. Disable the debugger now, before anything else** (old copy, namespace `default`).
Removing the port from the Service is not enough: the old process still listens on 9229 inside the cluster.
```
kubectl -n default edit service stockdesk             # remove the 9229 port entry and save
# restart the old pod without --inspect (same image, same port 3000; the old image has WORKDIR /app)
kubectl -n default patch deployment stockdesk --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["node","src/server.js"]}]'
kubectl -n default rollout status deployment/stockdesk
kubectl -n default exec deploy/stockdesk -- cat /proc/1/cmdline   # must not contain --inspect
```
Cost: a short interruption, and the in-memory stock resets to its initial values.

**1. Find out before changing anything**
- [ ] Who uses StockDesk today and from where: people through the LoadBalancer IP (which office / VPN ranges?),
      scripts or systems using the API key.
- [ ] Other ways in: `kubectl get svc,ingress -A -o wide | grep -i stockdesk` (NodePorts, Ingress routes).
- [ ] Does the network plugin enforce NetworkPolicy? (e.g. Calico or Cilium do; some basic plugins do not.)
- [ ] Where the database runs, and whether a `docker compose` copy runs on a test server.
      `DB_HOST` assumes the Service `db` in namespace `default`:
      - `kubectl -n default get svc db` must exist (if not, find the real address and change `DB_HOST`);
      - `kubectl -n default get networkpolicy`: a policy there may refuse connections from namespace `stockdesk`;
      - after the deploy, `/health` answering `200` proves the database is reachable from the new namespace.

**2. Fill in the placeholders**
- [ ] `k8s/admin/service.yaml` is **not deployable as written**: replace `203.0.113.0/24` (a documentation range) with the real ranges found in step 1, **or** switch to
      `type: ClusterIP` if nobody outside the cluster needs direct access (then narrow the NetworkPolicy ingress).
- [ ] `k8s/deployment.yaml`: set `DB_HOST` to the address found in step 1 if it is not `db.default.svc`.
- [ ] `k8s/admin/networkpolicy.yaml`: restrict egress on 5432 to the database (examples in the file).

**3. Apply, in this order**
```
kubectl apply -f k8s/admin/namespace.yaml -f k8s/admin/serviceaccount.yaml -f k8s/admin/ci-deployer-rbac.yaml
kubectl -n stockdesk create secret generic stockdesk-env \
  --from-literal=DB_PASSWORD="$(read -rs p; echo "$p")" --from-literal=API_KEY="$(read -rs k; echo "$k")"
kubectl apply -f k8s/admin/service.yaml -f k8s/admin/networkpolicy.yaml
```
- [ ] Build a kubeconfig from the `ci-deployer-token` Secret, store it as `KUBECONFIG` in the GitHub environment
      `test-cluster`; check its rights: `kubectl auth can-i --list -n stockdesk` (no `secrets`, no `serviceaccounts`; remember it can still reach Secrets through the Deployment, RISKS.md #4b) and
      `kubectl auth can-i get pods -n default` (must be `no`).
- [ ] Merge to `main` (or re-run the pipeline) and approve the deploy.

**4. Check the result**
- [ ] `kubectl -n stockdesk get pods` shows `Running` and `1/1` ready (if it stays `0/1`, the database is not
      reachable: check `DB_HOST` and the NetworkPolicies on both sides).
- [ ] From an allowed network: `curl http://<new-LB-IP>/livez` and `/api/products` answer.
- [ ] From outside the allowed ranges: no answer.
- [ ] Port 9229 does not answer on the new IP: `nc -zv <new-LB-IP> 9229` fails.
- [ ] A POST to `/api/products/BOLT-M6/adjust` with the old API key returns 401.

**5. Cut over, then remove the old copy** (only once step 4 passes; timing decided by the CTO, see RISKS.md step 4)
- [ ] Give clients the new endpoint and API key, ideally via a DNS name Corvane controls pointing to the new
      LoadBalancer, so the next IP change is a DNS change.
- [ ] Confirm each known client works on the new endpoint; watch the old one until legitimate traffic stops
      (scripts may have the old IP hard-coded).
- [ ] Revoke the old DB credential (RISKS.md step 4d), then:
```
kubectl -n default delete deployment/stockdesk service/stockdesk secret/stockdesk-env
```
- [ ] The old LoadBalancer IP no longer answers on 80 or 9229.

The rotation of the exposed secrets is in `RISKS.md`, section "Secrets already exposed".
