#!/usr/bin/env bash
# Download pinned scanner/linter releases and verify their SHA-256 before use.
# Usage: install-tools.sh <dest-dir> <tool>...   (tools: gitleaks kubeconform actionlint trivy)
#
# What the hard-coded hashes prove, and what they do not:
#  - They were taken on 2026-11-19 from the release assets and compared with the
#    checksum file of the same GitHub release. Same source, so this does NOT prove
#    the release was clean on that day.
#  - Trivy only: the archive's Sigstore signature was also checked with cosign
#    (signed by aquasecurity/trivy's GitHub release workflow, logged 2026-11-05).
#    That proves origin, not that the release workflow itself was not compromised.
#  - What they do guarantee: CI runs exactly those bytes. A release replaced or
#    tampered with later fails the check instead of running.
# This reduces supply-chain risk; it does not remove it. Scanner jobs also hold no
# secrets, which limits the damage if a tool is malicious anyway.
# Dependabot does not update these: review them when you update the tools.
set -euo pipefail

dest="$1"; shift
mkdir -p "$dest"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # url sha256 output
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$3" "$1"
  echo "$2  $3" | sha256sum --check --strict
}

for tool in "$@"; do
  case "$tool" in
    gitleaks)
      fetch "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz" \
        551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$tmp/gitleaks.tgz"
      tar -xzf "$tmp/gitleaks.tgz" -C "$dest" gitleaks ;;
    kubeconform)
      fetch "https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz" \
        9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 "$tmp/kubeconform.tgz"
      tar -xzf "$tmp/kubeconform.tgz" -C "$dest" kubeconform ;;
    actionlint)
      fetch "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz" \
        8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$tmp/actionlint.tgz"
      tar -xzf "$tmp/actionlint.tgz" -C "$dest" actionlint ;;
    trivy)
      # Binary release, not aquasecurity/trivy-action: that action's tags were
      # force-pushed to a credential stealer in March 2026 (CVE-2026-33634).
      # Signature checked once with cosign on 2026-11-19 (see header). To re-check:
      #   cosign verify-blob trivy_0.76.2_Linux-64bit.tar.gz \
      #     --bundle trivy_0.76.2_Linux-64bit.tar.gz.sigstore.json \
      #     --certificate-identity-regexp '^https://github\.com/aquasecurity/trivy/\.github/workflows/.+' \
      #     --certificate-oidc-issuer https://token.actions.githubusercontent.com
      fetch "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/trivy_0.76.2_Linux-64bit.tar.gz" \
        bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf "$tmp/trivy.tgz"
      tar -xzf "$tmp/trivy.tgz" -C "$dest" trivy ;;
    *) echo "unknown tool: $tool" >&2; exit 1 ;;
  esac
done
