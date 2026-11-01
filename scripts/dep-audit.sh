#!/usr/bin/env bash
# Dependency audit for EVERY Go module, Cargo crate and npm package in the monorepo.
# Fails on any Go/Rust vulnerability and on npm high/critical (prod deps only), minus
# unexpired entries in .security/audit-ignore.txt. Used by `make audit` and sdlc-vuln.yml.
# Needs: govulncheck, cargo-audit, node/npm on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."
# modules without a toolchain directive would otherwise audit against whatever local Go is installed
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.26.10}"
IGN=.security/audit-ignore.txt
today=$(date -u +%F)
# active ignored ids (expired ones are dropped)
ignored() { awk -v t="$today" '$1 !~ /^#/ && NF>=2 && $2>=t {print $1}' "$IGN"; }
expired=$(awk -v t="$today" '$1 !~ /^#/ && NF>=2 && $2<t {print $1}' "$IGN")
[ -n "$expired" ] && echo "NOTE: expired ignore entries no longer apply: $expired"
IGNORED=$(ignored | tr '\n' ' ')
is_ignored() { for i in $IGNORED; do [ "$i" = "$1" ] && return 0; done; return 1; }
fail=0

echo "== govulncheck =="
for mod in $(find . -name go.mod -not -path '*/node_modules/*' -not -path './gen/*' -not -path '*/vendor/*' -exec dirname {} \; | sort); do
  out=$(cd "$mod" && govulncheck -tags e2e ./... 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    ids=$(printf '%s\n' "$out" | grep -oE 'GO-[0-9]{4}-[0-9]+' | sort -u)
    bad=""; for i in $ids; do is_ignored "$i" || bad="$bad $i"; done
    if [ -z "$ids" ] || [ -n "$bad" ]; then echo "FAIL $mod:${bad:- (govulncheck error)}"; printf '%s\n' "$out" | tail -25; fail=1; else echo "ok   $mod (only ignored: $ids)"; fi
  else echo "ok   $mod"; fi
done

echo "== cargo audit =="
for lock in $(find . -name Cargo.lock -not -path '*/node_modules/*' -not -path '*/target/*' | sort); do
  d=$(dirname "$lock"); args=""; for i in $IGNORED; do case $i in RUSTSEC-*) args="$args --ignore $i";; esac; done
  # shellcheck disable=SC2086
  if (cd "$d" && cargo audit $args >"${TMPDIR:-/tmp}/ca.log" 2>&1); then echo "ok   $d"; else echo "FAIL $d"; tail -25 "${TMPDIR:-/tmp}/ca.log"; fail=1; fi
done

echo "== npm audit (--omit=dev, high+) =="
for pkg in apps/web services/imessage-bridge services/whatsapp-bridge packages/bridge-core packages/sdk-ts site; do
  [ -f "$pkg/package.json" ] || { echo "skip $pkg (no package.json)"; continue; }
  json=$(cd "$pkg" && { [ -f package-lock.json ] || npm install --package-lock-only --ignore-scripts --no-audit >/dev/null 2>&1; } && npm audit --omit=dev --audit-level=high --json 2>/dev/null)
  # keep high/critical findings whose advisory ids (GHSA in via[].url) are not all ignored
  bad=$(printf '%s' "$json" | IGNORED="$IGNORED" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let r;try{r=JSON.parse(s)}catch{console.log("audit-error");return}
      const ig=new Set((process.env.IGNORED||"").split(/\s+/).filter(Boolean));
      const out=[];
      for(const [n,v] of Object.entries(r.vulnerabilities||{})){
        if(!["high","critical"].includes(v.severity))continue;
        const ids=v.via.filter(x=>typeof x==="object").map(x=>(x.url||"").split("/").pop());
        if(ids.length&&ids.every(i=>ig.has(i)))continue;
        out.push(n+"("+v.severity+")"+(ids.length?" "+ids.join(","):""));
      }
      console.log(out.join("; "));});')
  if [ -n "$bad" ]; then echo "FAIL $pkg: $bad"; fail=1; else echo "ok   $pkg"; fi
done
exit $fail
