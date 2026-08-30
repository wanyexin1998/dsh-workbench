#!/usr/bin/env bash
# DSH Workbench source-bootstrap installer (macOS).
#
# Automates docs/INSTALL.md §1-3 (A3, plans/260827-workbench-v2/tasks.md §3):
# downloads (or accepts a pre-downloaded) Workbench release TGZ, clones and
# verifies the pinned Harness fork by exact commit (never a mutable
# branch/tag), builds it, verifies and installs the TGZ into an ISOLATED
# profile, runs a post-install load verification, and writes a launcher.
#
# ISOLATION INVARIANT (by construction): every path this script writes is
# derived from a single root, --target. It never touches the official
# ~/.dsh install, PATH, a shell profile, or any system location -- apart
# from pnpm's own global package store/cache, which pnpm manages outside
# --target regardless of what invokes it (this script does not configure or
# rely on that store's location). Deleting --target removes everything this
# script itself ever wrote.
#
# TRUST MODEL: the Harness fork's repository URL and branch name below are
# informational only. The only thing this script ever trusts is the exact
# 40-character commit hash pinned as a constant -- it is never resolved from
# a branch or tag, and every git step that could silently diverge from it
# (clone, checkout, HEAD verification, detached-HEAD proof, clean-worktree
# check) aborts the whole run immediately on any failure (fail closed). The
# Workbench release TGZ (whether downloaded by this script or supplied via
# --tgz) is likewise never used before its SHA256 has been verified.
#
# Usage:
#   dsh-workbench-bootstrap.sh [--target <dir>] [--tgz-sha256 <hex>]
#   dsh-workbench-bootstrap.sh [--target <dir>] --tgz <path> [--tgz-sha256 <hex>]
#   dsh-workbench-bootstrap.sh --check-only [--target <dir>] [--tgz <path>] [--tgz-sha256 <hex>]
#
# By default (no --tgz), this script downloads the pinned-version Workbench
# release TGZ itself from the embedded RELEASE_BASE_URL into
# <target>/downloads/, then verifies it against the embedded
# WORKBENCH_TGZ_SHA256 (or an explicit --tgz-sha256, before that constant is
# stamped at release time -- see below). --tgz <path> is an OFFLINE OVERRIDE:
# point it at an already-downloaded TGZ to skip the network download
# entirely. Either way, the TGZ is hash-verified before any use.
#
# Output: the LAST line written to stdout is always exactly one JSON object
# shaped like scripts/install/result.mjs's InstallResult contract:
#   { "schema": 1, "state", "reason", "nextStep", "details" }
# where state is one of: installed | manual-action-required | incompatible | failed.
#
# Process exit code contract (not part of result.mjs; this script's own,
# documented mapping from state to exit code, for shell/CI use):
#   installed              -> 0
#   manual-action-required -> 2
#   incompatible            -> 3  (reserved; no current code path emits it)
#   failed                  -> 1
#
# ARGUMENT-PARSING PARITY NOTE (B4): a two-arg flag with no following value
# (e.g. a bare trailing `--tgz-sha256`) is explicitly guarded below and
# always exits promptly with a `failed` JSON per the contract above. The
# `.ps1` sibling errors loudly for the same input too, but NOT through the
# JSON contract: PowerShell's own typed-parameter binder rejects a missing
# argument value before that script's body ever runs, printing its own
# diagnostic to stderr and exiting nonzero -- this is intentional platform
# behavior, not a gap to fix, since a caller scripting around either tool
# already has to check the exit code regardless of stdout shape.
#
# POSIX-leaning: avoids GNU-only flags so it runs under macOS's bundled bash
# and coreutils/BSD userland (e.g. tries `shasum -a 256` before falling back
# to `sha256sum`). Does NOT use `set -e`: every state must terminate through
# emit_result_and_exit so the JSON-last-line contract holds even on failure;
# an EXIT trap (below) additionally catches any death that bypasses
# emit_result_and_exit entirely (e.g. an unbound-variable death under
# `set -u`) and still emits a valid `failed` JSON as the last line.
set -u

# RESULT_EMITTED is flipped to 1 only by emit_result_and_exit, immediately
# before it prints the JSON line and exits. Declared this early (before the
# constants block) so it is always defined by the time anything could fail.
RESULT_EMITTED=0

# --- Pinned constants (embedded; NEVER fetched from a mutable ref) ---------
#
# These mirror release-contract.json's `harness` block and docs/INSTALL.md
# §2. Keep them in sync with release-contract.json by hand; this script does
# not read that file at run time (it must stay fully self-contained once
# attached to an immutable GitHub Release).
HARNESS_REPO_URL='https://github.com/wanyexin1998/deepseek-harness.git'
# Informational only -- see the TRUST MODEL note above. Never used to select
# what gets checked out; only the pinned commit below is.
HARNESS_FORK_BRANCH='fix/plugin-spec-quoting'
HARNESS_COMMIT='1a8cf5ba416246f22d9526a917af5fb233170c58'
# The upstream DeepSeek Harness commit the fork branch is based on
# (release-contract.json harness.upstreamCommit). Recorded here only for
# the self-consistency check and diagnostic output; never checked out.
HARNESS_UPSTREAM_BASE_COMMIT='b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
WORKBENCH_VERSION='0.2.0-rc.2'
WORKBENCH_TGZ_FILENAME="wanyexin1998-dsh-workbench-${WORKBENCH_VERSION}.tgz"
# Base URL for this script's own default TGZ download (B1): the GitHub
# Release this script itself is attached to as an asset. Kept as its own
# constant (rather than derived purely from WORKBENCH_VERSION) so the
# self-consistency check below can catch a hand-edit that changes one but
# not the other.
RELEASE_BASE_URL='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'
# STAMPED-AT-RELEASE: placeholder. Replaced with the real lowercase 64-hex
# SHA256 of the release TGZ when this script is attached to the GitHub
# Release (see plans/260827-workbench-v2/tasks.md §8). While this constant
# still holds the placeholder, a real run REQUIRES --tgz-sha256 on the
# command line and refuses to install (or even download) an unverified
# artifact otherwise.
WORKBENCH_TGZ_SHA256='974716952ac8ac406a3e8fa2af59db722fe1c0c6e20ccc321356d1b0754da6c7'
RESULT_SCHEMA=1

# --- Argument parsing --------------------------------------------------------

TARGET=""
TGZ=""
TGZ_SHA256=""
CHECK_ONLY=0

# json_escape/emit_result/exit_code_for_state are defined before argument
# parsing runs so a bad argument can still terminate through the same
# JSON-last-line contract as every other failure path.

json_escape() {
    # Escapes a string for embedding inside one JSON string literal.
    # Backslash and double-quote only; paths/messages here are not expected
    # to contain control characters, but a stray newline is flattened to a
    # space so it can never break the single-line JSON contract.
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '
}

exit_code_for_state() {
    case "$1" in
        installed) printf '0' ;;
        manual-action-required) printf '2' ;;
        incompatible) printf '3' ;;
        failed) printf '1' ;;
        *) printf '1' ;;
    esac
}

emit_result_and_exit() {
    # $1=state $2=reason $3=nextStep ("" means JSON null) $4=details (raw
    # JSON fragment, e.g. '{"a":"b"}', or "null"; "" also means null)
    state="$1"
    reason="$2"
    next_step="$3"
    details="$4"

    if { [ "$state" = "manual-action-required" ] || [ "$state" = "failed" ]; } && [ -z "$next_step" ]; then
        # Internal contract bug, not a user-facing outcome -- but the
        # JSON-last-line contract must still hold even when OUR OWN code has
        # a bug (S6), so log the real cause to stderr and then downgrade to
        # a valid `failed` JSON instead of a bare `exit 1` with no JSON line.
        printf 'internal error: emit_result_and_exit state %s requires a non-empty nextStep\n' "$state" >&2
        state="failed"
        reason="Internal error: emit_result_and_exit contract violation (missing nextStep for state '$1')."
        next_step="Report this to the maintainer; this indicates a bug in the bootstrap script itself, not your environment."
    fi

    reason_json="$(json_escape "$reason")"
    if [ -n "$next_step" ]; then
        next_step_json="\"$(json_escape "$next_step")\""
    else
        next_step_json="null"
    fi
    if [ -z "$details" ]; then
        details="null"
    fi

    RESULT_EMITTED=1
    printf '{"schema":%s,"state":"%s","reason":"%s","nextStep":%s,"details":%s}\n' \
        "$RESULT_SCHEMA" "$state" "$reason_json" "$next_step_json" "$details"
    exit "$(exit_code_for_state "$state")"
}

print_human_block() {
    printf '%s\n\n' "$1"
}

# --- JSON-last-line contract safety net (S6) ----------------------------------
# The EXIT trap fires on EVERY exit of THIS shell, for any reason (including
# an unbound-variable death under `set -u`), but is NOT re-fired inside `(
# subshell )` or `$(command substitution)` contexts -- only the top-level
# shell's own exit triggers it. If it fires while RESULT_EMITTED is still 0,
# this script is about to die without ever honoring the JSON-last-line
# contract, so the trap emits a fallback `failed` JSON itself before exiting.
trap_unexpected_exit() {
    trap_exit_status=$?
    if [ "$RESULT_EMITTED" -ne 1 ]; then
        printf '{"schema":%s,"state":"failed","reason":"%s","nextStep":%s,"details":null}\n' \
            "$RESULT_SCHEMA" \
            "$(json_escape "Unexpected script termination (exit code ${trap_exit_status}) before any terminal state was emitted.")" \
            "\"$(json_escape 'Re-run this script; if the failure repeats, re-run with `bash -x` for a trace and report it to the maintainer.')\""
    fi
}
trap trap_unexpected_exit EXIT

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            if [ $# -lt 2 ]; then
                emit_result_and_exit failed '--target requires a value.' \
                    "Run with the documented flags only: --target <dir>, --tgz <path>, --tgz-sha256 <hex>, --check-only." ""
            fi
            TARGET="$2"
            shift 2
            ;;
        --target=*)
            TARGET="${1#--target=}"
            shift
            ;;
        --tgz)
            if [ $# -lt 2 ]; then
                emit_result_and_exit failed '--tgz requires a value.' \
                    "Run with the documented flags only: --target <dir>, --tgz <path>, --tgz-sha256 <hex>, --check-only." ""
            fi
            TGZ="$2"
            shift 2
            ;;
        --tgz=*)
            TGZ="${1#--tgz=}"
            shift
            ;;
        --tgz-sha256)
            if [ $# -lt 2 ]; then
                emit_result_and_exit failed '--tgz-sha256 requires a value.' \
                    "Run with the documented flags only: --target <dir>, --tgz <path>, --tgz-sha256 <hex>, --check-only." ""
            fi
            TGZ_SHA256="$2"
            shift 2
            ;;
        --tgz-sha256=*)
            TGZ_SHA256="${1#--tgz-sha256=}"
            shift
            ;;
        --check-only)
            CHECK_ONLY=1
            shift
            ;;
        *)
            emit_result_and_exit failed "Unknown argument: $1" \
                "Run with the documented flags only: --target <dir>, --tgz <path>, --tgz-sha256 <hex>, --check-only." ""
            ;;
    esac
done

if [ -z "$TARGET" ]; then
    TARGET="$HOME/dsh-workbench"
fi

# --- Path helpers -------------------------------------------------------------

abs_path() {
    # Resolves $1 to an absolute path without relying on GNU-only realpath/
    # readlink -f (not reliably present on macOS). Works whether $1 exists
    # as a file, a directory, or does not exist yet (treated as a directory
    # to be created).
    target_path="$1"
    if [ -d "$target_path" ]; then
        (cd "$target_path" 2>/dev/null && pwd)
    elif [ -e "$target_path" ]; then
        dir_part="$(dirname "$target_path")"
        base_part="$(basename "$target_path")"
        resolved_dir="$(cd "$dir_part" 2>/dev/null && pwd)"
        if [ -n "$resolved_dir" ]; then
            printf '%s/%s' "$resolved_dir" "$base_part"
        fi
    else
        dir_part="$(dirname "$target_path")"
        base_part="$(basename "$target_path")"
        resolved_dir="$(cd "$dir_part" 2>/dev/null && pwd)"
        if [ -n "$resolved_dir" ]; then
            printf '%s/%s' "$resolved_dir" "$base_part"
        fi
    fi
}

ABS_TARGET="$(abs_path "$TARGET")"
if [ -z "$ABS_TARGET" ]; then
    # dirname of $TARGET does not exist; fall back to a literal join so
    # downstream directory-creation still reports a sensible path.
    ABS_TARGET="$TARGET"
fi

# --- Isolation invariant: every write path is derived from $ABS_TARGET -----
HARNESS_CHECKOUT_DIR="$ABS_TARGET/deepseek-harness"
DSH_HOME_DIR="$ABS_TARGET/home"
LAUNCHER_PATH="$ABS_TARGET/dsh-workbench"
DOWNLOADS_DIR="$ABS_TARGET/downloads"

# --- Phase 0: preconditions --------------------------------------------------

test_preconditions() {
    if ! command -v node >/dev/null 2>&1; then
        emit_result_and_exit failed 'Node.js was not found on PATH.' \
            'Install Node.js ^22.19 or >=24 (https://nodejs.org/), then re-run this script.' ""
    fi
    node_version_raw="$(node --version 2>/dev/null)"
    node_version="${node_version_raw#v}"
    node_major="${node_version%%.*}"
    node_rest="${node_version#*.}"
    node_minor="${node_rest%%.*}"
    case "$node_major" in ''|*[!0-9]*) node_major=-1 ;; esac
    case "$node_minor" in ''|*[!0-9]*) node_minor=-1 ;; esac
    node_ok=0
    if [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 19 ]; then node_ok=1; fi
    if [ "$node_major" -ge 24 ]; then node_ok=1; fi
    if [ "$node_ok" -ne 1 ]; then
        emit_result_and_exit failed "Node.js ${node_version_raw} does not satisfy the required range (^22.19 || >=24)." \
            'Install Node.js ^22.19 or >=24 (https://nodejs.org/), then re-run this script.' ""
    fi

    if ! command -v pnpm >/dev/null 2>&1; then
        emit_result_and_exit failed 'pnpm was not found on PATH.' \
            'Install pnpm 11 (e.g. `corepack enable` then `corepack prepare pnpm@11 --activate`), then re-run this script.' ""
    fi
    pnpm_version_raw="$(pnpm --version 2>/dev/null)"
    pnpm_major="${pnpm_version_raw%%.*}"
    case "$pnpm_major" in ''|*[!0-9]*) pnpm_major=-1 ;; esac
    if [ "$pnpm_major" -ne 11 ]; then
        emit_result_and_exit failed "pnpm ${pnpm_version_raw} does not satisfy the required major version (11)." \
            'Install pnpm 11 (e.g. `corepack enable` then `corepack prepare pnpm@11 --activate`), then re-run this script.' ""
    fi

    if ! command -v git >/dev/null 2>&1; then
        emit_result_and_exit failed 'git was not found on PATH.' \
            'Install Git (e.g. via Xcode Command Line Tools: `xcode-select --install`, or Homebrew: `brew install git`), then re-run this script.' ""
    fi
}

# --- Pin self-consistency ------------------------------------------------------

test_pin_self_consistency() {
    problems=""
    case "$HARNESS_COMMIT" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
        *) problems="${problems}the embedded Harness commit is not a lowercase 40-hex-character hash; " ;;
    esac
    case "$HARNESS_UPSTREAM_BASE_COMMIT" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
        *) problems="${problems}the embedded Harness upstream base commit is not a lowercase 40-hex-character hash; " ;;
    esac
    expected_tgz="wanyexin1998-dsh-workbench-${WORKBENCH_VERSION}.tgz"
    if [ "$WORKBENCH_TGZ_FILENAME" != "$expected_tgz" ]; then
        problems="${problems}the embedded Workbench TGZ filename does not match the embedded Workbench version; "
    fi
    expected_release_base="https://github.com/wanyexin1998/dsh-workbench/releases/download/v${WORKBENCH_VERSION}"
    if [ "$RELEASE_BASE_URL" != "$expected_release_base" ]; then
        problems="${problems}the embedded RELEASE_BASE_URL does not match the embedded Workbench version; "
    fi
    if [ "$WORKBENCH_TGZ_SHA256" != "STAMPED-AT-RELEASE" ]; then
        # S4: length AND full-charset checks, both required -- a
        # `[0-9a-f]*[0-9a-f]` glob only inspects the first/last character
        # and lets anything through in between, which is not a real hex
        # check. Mirror the same two-part validation --tgz-sha256 itself
        # uses below, and the .ps1's `^[0-9a-f]{64}$` regex.
        hash_len=${#WORKBENCH_TGZ_SHA256}
        if [ "$hash_len" -ne 64 ]; then
            problems="${problems}the embedded Workbench TGZ SHA256 is neither the STAMPED-AT-RELEASE placeholder nor a 64-hex SHA256 hash; "
        else
            case "$WORKBENCH_TGZ_SHA256" in
                *[!0-9a-f]*)
                    problems="${problems}the embedded Workbench TGZ SHA256 is neither the STAMPED-AT-RELEASE placeholder nor a lowercase 64-hex SHA256 hash; "
                    ;;
            esac
        fi
    fi
    if [ -n "$problems" ]; then
        emit_result_and_exit failed "Embedded pin self-consistency check failed: ${problems}" \
            'Do not trust this copy of the script. Re-download it from the official GitHub Release page and verify it against the published SHA256SUMS before running it again.' ""
    fi
}

# --- --check-only planned-actions text ----------------------------------------

print_planned_actions() {
    if [ -n "$TGZ" ]; then
        tgz_source_block="Use the already-downloaded TGZ at:
       ${TGZ}
     (offline --tgz override; no download)."
    else
        tgz_source_block="Download the Workbench release TGZ (${WORKBENCH_TGZ_FILENAME}) from:
       ${RELEASE_BASE_URL}
     into:
       ${DOWNLOADS_DIR}"
    fi
    cat <<PLAN
Planned actions for a full run (this --check-only run performed NONE of
these: no network access, no writes):
  1. ${tgz_source_block}
     Verify it against its SHA256 before any use (either path).
  2. Clone ${HARNESS_REPO_URL}
     (branch '${HARNESS_FORK_BRANCH}' is informational only; the actual checkout
     is pinned to commit ${HARNESS_COMMIT}, detached, verified) into:
       ${HARNESS_CHECKOUT_DIR}
  3. Run 'pnpm install --frozen-lockfile' then 'pnpm build' inside that checkout.
  4. Install the verified TGZ, with DSH_HOME scoped to that one child process only:
       DSH_HOME=${DSH_HOME_DIR}  pnpm dsh plugin --profile web add file:<verified-tgz-path>
  5. Post-install load verification (no boot), same DSH_HOME scoping:
       DSH_HOME=${DSH_HOME_DIR}  pnpm dsh --profile web --dump-config
     and confirm the Workbench package name appears in its output before
     declaring success.
  6. Write an isolated launcher at:
       ${LAUNCHER_PATH}

Isolation: every path above is derived from --target (${ABS_TARGET}), apart
from pnpm's own global package store/cache, which pnpm manages outside
--target. Nothing else outside --target is ever written to -- no ~/.dsh, no
PATH, no shell profile.
PLAN
}

# --- Phase 1: acquire fork ------------------------------------------------------

phase1_acquire_fork() {
    if [ -e "$HARNESS_CHECKOUT_DIR" ]; then
        emit_result_and_exit failed "Target checkout directory already exists: ${HARNESS_CHECKOUT_DIR}. Refusing to overwrite an existing directory (fail closed)." \
            "Remove or rename ${HARNESS_CHECKOUT_DIR}, or choose a different --target, then re-run this script." ""
    fi

    mkdir -p "$ABS_TARGET"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "Failed to create the target directory: ${ABS_TARGET}" \
            'Ensure the parent directory is writable, then re-run this script.' ""
    fi

    git clone --no-checkout "$HARNESS_REPO_URL" "$HARNESS_CHECKOUT_DIR"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'git clone of the Harness fork failed.' \
            "Check your network connection and that ${HARNESS_REPO_URL} is reachable, then re-run this script." ""
    fi

    git -C "$HARNESS_CHECKOUT_DIR" checkout --detach "$HARNESS_COMMIT"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "git checkout --detach ${HARNESS_COMMIT} failed." \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    fi

    resolved_commit="$(git -C "$HARNESS_CHECKOUT_DIR" rev-parse --verify HEAD)"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'Failed to resolve the Harness fork HEAD.' \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    fi
    resolved_commit_lower="$(printf '%s' "$resolved_commit" | tr '[:upper:]' '[:lower:]')"
    pinned_lower="$(printf '%s' "$HARNESS_COMMIT" | tr '[:upper:]' '[:lower:]')"
    if [ "$resolved_commit_lower" != "$pinned_lower" ]; then
        emit_result_and_exit failed "Harness commit mismatch: expected ${HARNESS_COMMIT}, got ${resolved_commit}." \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script. If the mismatch persists, do not proceed -- report this to the maintainer." ""
    fi

    git -C "$HARNESS_CHECKOUT_DIR" symbolic-ref -q HEAD >/dev/null 2>&1
    symbolic_ref_status=$?
    if [ "$symbolic_ref_status" -eq 0 ]; then
        emit_result_and_exit failed 'Harness fork checkout is not in detached HEAD state.' \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    elif [ "$symbolic_ref_status" -ne 1 ]; then
        emit_result_and_exit failed "Failed to verify the Harness fork's detached-HEAD state (unexpected git exit code ${symbolic_ref_status})." \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    fi

    worktree_state="$(git -C "$HARNESS_CHECKOUT_DIR" status --porcelain=v1 --untracked-files=all)"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'Failed to verify the Harness fork worktree state.' \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    fi
    if [ -n "$worktree_state" ]; then
        emit_result_and_exit failed 'Harness fork worktree is not clean immediately after checkout.' \
            "Delete ${HARNESS_CHECKOUT_DIR} and re-run this script." ""
    fi
}

# --- Phase 2: build fork ---------------------------------------------------------

phase2_build_fork() {
    ( cd "$HARNESS_CHECKOUT_DIR" && pnpm install --frozen-lockfile )
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'pnpm install --frozen-lockfile failed inside the Harness fork checkout.' \
            "Re-run this script from a clean --target, or run 'pnpm install --frozen-lockfile' manually inside ${HARNESS_CHECKOUT_DIR} to see the underlying error." ""
    fi

    ( cd "$HARNESS_CHECKOUT_DIR" && pnpm build )
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'pnpm build failed inside the Harness fork checkout.' \
            "Re-run this script from a clean --target, or run 'pnpm build' manually inside ${HARNESS_CHECKOUT_DIR} to see the underlying error." ""
    fi
}

# --- Phase 3: workbench TGZ verify + install --------------------------------------

phase3_install_tgz() {
    abs_tgz_path="$1"
    mkdir -p "$DSH_HOME_DIR"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "Failed to create the isolated DSH_HOME directory: ${DSH_HOME_DIR}" \
            'Ensure the target directory is writable, then re-run this script.' ""
    fi

    # DSH_HOME is set only in the environment of this one subshell's child
    # process -- it is never exported into the parent shell that invoked
    # this script.
    ( cd "$HARNESS_CHECKOUT_DIR" && DSH_HOME="$DSH_HOME_DIR" pnpm dsh plugin --profile web add "file:${abs_tgz_path}" )
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed 'dsh plugin --profile web add failed while installing the Workbench TGZ into the isolated profile.' \
            "Re-run this script, or run it manually with DSH_HOME=${DSH_HOME_DIR} inside ${HARNESS_CHECKOUT_DIR} to see the underlying error." ""
    fi
}

# --- Phase 3b: post-install load verification (S2) --------------------------------

phase3b_verify_load() {
    # A successful `dsh plugin add` only proves the package was written into
    # the profile's node_modules -- not that it actually loads. This is the
    # reviewer-confirmed no-boot probe: ask the installed Harness to dump its
    # resolved config for the same isolated profile, and confirm the
    # Workbench package name shows up in it, before this script is allowed
    # to declare `installed`.
    verify_output="$( cd "$HARNESS_CHECKOUT_DIR" && DSH_HOME="$DSH_HOME_DIR" pnpm dsh --profile web --dump-config 2>&1 )"
    verify_status=$?
    if [ "$verify_status" -ne 0 ]; then
        emit_result_and_exit failed 'Post-install load verification failed: `dsh --profile web --dump-config` exited non-zero.' \
            "Run manually with DSH_HOME=${DSH_HOME_DIR} inside ${HARNESS_CHECKOUT_DIR} to see the underlying error, then re-run this script from a clean --target." ""
    fi
    case "$verify_output" in
        *"@wanyexin1998/dsh-workbench"*)
            ;;
        *)
            emit_result_and_exit failed 'Post-install load verification ran but the Workbench package name did not appear in `dsh --profile web --dump-config` output; the plugin may not have loaded correctly.' \
                "Run manually with DSH_HOME=${DSH_HOME_DIR} inside ${HARNESS_CHECKOUT_DIR} to inspect the output, then re-run this script from a clean --target." ""
            ;;
    esac
}

# --- Phase 4: launcher -------------------------------------------------------------

phase4_write_launcher() {
    # S1: the launcher body below is fully self-relative (derives its own
    # directory from `$0` at run time) and therefore contains NO absolute
    # path written by this script -- so nothing here can ever go stale or
    # get corrupted by an encoding mismatch on a non-ASCII --target path.
    # The heredoc delimiter is quoted ('LAUNCHER') specifically so none of
    # THIS script's shell variables are interpolated into the launcher body.
    #
    # NOTE: the heredoc body below is written unconditionally first, then
    # its exit status is checked via $? afterward -- `<<LAUNCHER || { ... }`
    # on one line would NOT work as a guard here: everything up to the next
    # bare `LAUNCHER` line (including a `{ ... }` fallback block) would be
    # swallowed into the heredoc's literal text instead of being executed.
    cat > "$LAUNCHER_PATH" <<'LAUNCHER'
#!/bin/sh
# DSH Workbench isolated launcher -- generated by dsh-workbench-bootstrap.sh
# Self-relative: reads/writes only inside this launcher's own directory.
# Never touches the official dsh install, PATH, or shell profiles.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR/deepseek-harness" || exit 1
DSH_HOME="$SCRIPT_DIR/home" exec pnpm dsh web "$@"
LAUNCHER
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "Failed to write the launcher script at ${LAUNCHER_PATH}." \
            'Ensure the target directory is writable, then re-run this script.' ""
    fi
    chmod +x "$LAUNCHER_PATH" 2>/dev/null
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "Failed to make the launcher script executable at ${LAUNCHER_PATH}." \
            'Ensure the target directory is writable, then re-run this script.' ""
    fi
}

# --- SHA256 helper (portable: shasum on macOS, sha256sum elsewhere) --------------

compute_sha256() {
    file_path="$1"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file_path" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file_path" | awk '{print $1}'
    else
        printf ''
    fi
}

# --- TGZ download (default acquisition path; B1) ----------------------------------

download_tgz() {
    # $1=url $2=destination path. Downloads to a .partial sibling file first
    # so a failed or interrupted download can never be mistaken for a
    # complete artifact -- the real destination path only ever contains a
    # fully-downloaded file, and it is still hash-verified by the caller
    # before any use regardless.
    url="$1"
    dest="$2"
    if ! command -v curl >/dev/null 2>&1; then
        emit_result_and_exit failed 'curl was not found on PATH; cannot download the Workbench release TGZ automatically.' \
            "Install curl, or download ${url} manually and re-run with --tgz <path>." ""
    fi
    tmp_dest="${dest}.partial"
    rm -f "$tmp_dest" 2>/dev/null
    curl -fsSL -o "$tmp_dest" "$url"
    curl_status=$?
    if [ "$curl_status" -ne 0 ]; then
        rm -f "$tmp_dest" 2>/dev/null
        emit_result_and_exit failed "Failed to download the Workbench release TGZ from ${url} (curl exit code ${curl_status})." \
            "Check your network connection and that the URL is reachable, or download it manually and re-run with --tgz <path>." ""
    fi
    mv "$tmp_dest" "$dest"
    if [ $? -ne 0 ]; then
        rm -f "$tmp_dest" 2>/dev/null
        emit_result_and_exit failed "Failed to finalize the downloaded TGZ at ${dest}." \
            'Ensure the target directory is writable, then re-run this script.' ""
    fi
}

# --- Main -----------------------------------------------------------------------

test_preconditions
test_pin_self_consistency

if [ "$CHECK_ONLY" -eq 1 ]; then
    next_step="$0 --target \"${ABS_TARGET}\""
    if [ -n "$TGZ" ]; then
        next_step="${next_step} --tgz \"${TGZ}\""
    fi
    if [ "$WORKBENCH_TGZ_SHA256" = "STAMPED-AT-RELEASE" ]; then
        hash_example="$TGZ_SHA256"
        if [ -z "$hash_example" ]; then
            hash_example='<sha256-from-SHA256SUMS>'
        fi
        next_step="${next_step} --tgz-sha256 \"${hash_example}\""
    fi
    print_human_block "Check-only: no network access, no writes performed.
仅检查模式：未联网，未写入任何文件。"
    print_planned_actions
    printf '\n'
    emit_result_and_exit manual-action-required \
        'Check-only mode: preconditions and embedded-pin self-consistency passed; no network access or writes were performed.' \
        "$next_step" ""
fi

# --- TGZ acquisition + verification (B1) -------------------------------------
# The expected hash is resolved FIRST, before any network access or file
# acquisition, so a run that could never pass verification (unstamped
# placeholder and no --tgz-sha256 override) fails fast without downloading
# anything.

expected_hash=""
if [ -n "$TGZ_SHA256" ]; then
    expected_hash="$(printf '%s' "$TGZ_SHA256" | tr '[:upper:]' '[:lower:]')"
    hash_len=${#expected_hash}
    case "$expected_hash" in
        *[!0-9a-f]*)
            emit_result_and_exit failed "--tgz-sha256 is not a valid 64-hex-character SHA256 hash: ${TGZ_SHA256}" \
                'Pass the correct SHA256 value from SHA256SUMS and re-run.' ""
            ;;
    esac
    if [ "$hash_len" -ne 64 ]; then
        emit_result_and_exit failed "--tgz-sha256 is not a valid 64-hex-character SHA256 hash: ${TGZ_SHA256}" \
            'Pass the correct SHA256 value from SHA256SUMS and re-run.' ""
    fi
elif [ "$WORKBENCH_TGZ_SHA256" != "STAMPED-AT-RELEASE" ]; then
    expected_hash="$(printf '%s' "$WORKBENCH_TGZ_SHA256" | tr '[:upper:]' '[:lower:]')"
else
    emit_result_and_exit failed "This script's embedded Workbench TGZ SHA256 has not been stamped for release yet (placeholder value), and no --tgz-sha256 override was supplied." \
        'Obtain the real SHA256 for the TGZ (e.g. from SHA256SUMS on the Release page) and re-run with --tgz-sha256 <hex>.' ""
fi

if [ -n "$TGZ" ]; then
    # Offline override: use the caller-supplied TGZ path as-is, no network access.
    if [ ! -f "$TGZ" ]; then
        emit_result_and_exit failed "TGZ file not found at path: ${TGZ}" \
            'Re-download the release TGZ, verify it against SHA256SUMS, then re-run with --tgz pointing at the correct file.' ""
    fi
    ABS_TGZ="$(abs_path "$TGZ")"
else
    # Default acquisition path: download the pinned-version release TGZ.
    mkdir -p "$DOWNLOADS_DIR"
    if [ $? -ne 0 ]; then
        emit_result_and_exit failed "Failed to create the downloads directory: ${DOWNLOADS_DIR}" \
            'Ensure the target directory is writable, then re-run this script.' ""
    fi
    ABS_TGZ="${DOWNLOADS_DIR}/${WORKBENCH_TGZ_FILENAME}"
    download_tgz "${RELEASE_BASE_URL}/${WORKBENCH_TGZ_FILENAME}" "$ABS_TGZ"
fi

computed_hash="$(compute_sha256 "$ABS_TGZ")"
if [ -z "$computed_hash" ]; then
    emit_result_and_exit failed 'Neither `shasum` nor `sha256sum` was found on PATH; cannot verify the TGZ.' \
        'Install coreutils (e.g. `brew install coreutils`) or ensure `shasum` is available, then re-run this script.' ""
fi
computed_hash="$(printf '%s' "$computed_hash" | tr '[:upper:]' '[:lower:]')"
if [ "$computed_hash" != "$expected_hash" ]; then
    emit_result_and_exit failed "TGZ SHA256 mismatch: expected ${expected_hash}, computed ${computed_hash}." \
        'Re-download the release TGZ and SHA256SUMS from the GitHub Release page; do not proceed with a mismatched artifact.' ""
fi

phase1_acquire_fork
phase2_build_fork
phase3_install_tgz "$ABS_TGZ"
phase3b_verify_load
phase4_write_launcher

details_json=$(printf '{"forkCommit":"%s","tgzSha256":"%s","targetDir":"%s"}' \
    "$(json_escape "$HARNESS_COMMIT")" "$(json_escape "$computed_hash")" "$(json_escape "$ABS_TARGET")")

print_human_block "DSH Workbench bootstrap install complete.
DSH Workbench 独立引导安装已完成。

Launch it with: ${LAUNCHER_PATH}
使用以下命令启动：${LAUNCHER_PATH}

This install is fully isolated under ${ABS_TARGET} (apart from pnpm's own
global package store/cache, which pnpm manages outside --target) and did not
modify your official Harness install, PATH, or shell profile in any way.
本次安装完全隔离在 ${ABS_TARGET} 目录下（pnpm 自身的全局包存储/缓存除外，
该部分由 pnpm 在 --target 之外自行管理），未以任何方式改动你的官方 Harness
安装、PATH 或 Shell 配置文件。"

emit_result_and_exit installed \
    'Harness fork verified, built, Workbench TGZ installed into the isolated profile, post-install load verification passed, and launcher written.' \
    "" "$details_json"
