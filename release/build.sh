#!/bin/bash
# ============================================================
# release/build.sh — Build y8-core artifacts for all platforms
#
# Usage:
#   ./release/build.sh              # build for current platform
#   ./release/build.sh all          # build all via Docker
#   ./release/build.sh manifest     # update manifest.json
#
# Output: release/dist/
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/release/dist"
mkdir -p "$DIST"

SOURCES="$ROOT/native/y8_qjson.c $ROOT/vendor/libbf/libbf.c $ROOT/vendor/libbf/cutils.c"
CFLAGS="-O2 -Wall -std=c11 -fPIC -DY8_USE_LIBBF -I$ROOT/vendor/libbf"

# ── Detect platform ─────────────────────────────────

UNAME_S=$(uname -s)
UNAME_M=$(uname -m)

case "$UNAME_S" in
    Linux)  OS="linux" ;;
    Darwin) OS="darwin" ;;
    *)      OS="unknown" ;;
esac

case "$UNAME_M" in
    x86_64)  ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       ARCH="$UNAME_M" ;;
esac

# ── Build native ────────────────────────────────────

build_native() {
    local os="$1" arch="$2"
    local name="liby8_core-${os}-${arch}"

    if [ "$os" = "darwin" ]; then
        local ext="dylib"
        local flags="-dynamiclib"
    else
        local ext="so"
        local flags="-shared"
    fi

    echo "Building $name.$ext ..."
    gcc $CFLAGS $flags -o "$DIST/$name.$ext" $SOURCES -lm
    echo "  $(wc -c < "$DIST/$name.$ext") bytes"
}

# ── Hash artifacts ──────────────────────────────────

hash_file() {
    shasum -a 256 "$1" | cut -d' ' -f1
}

# ── Generate manifest ──────────────────────────────

generate_manifest() {
    local version="${1:-dev}"
    local base_url="https://github.com/wmacevoy/wyatt/releases/download/v${version}"

    echo "{"
    echo "  \"version\": \"$version\","
    echo "  \"artifacts\": {"

    local first=true
    for f in "$DIST"/*; do
        [ -f "$f" ] || continue
        local name=$(basename "$f")
        local hash=$(hash_file "$f")
        local size=$(wc -c < "$f" | tr -d ' ')

        if [ "$first" = true ]; then first=false; else echo ","; fi
        printf "    \"%s\": {\n" "$name"
        printf "      \"url\": \"%s/%s\",\n" "$base_url" "$name"
        printf "      \"sha256\": \"%s\",\n" "$hash"
        printf "      \"size\": %s\n" "$size"
        printf "    }"
    done

    echo ""
    echo "  }"
    echo "}"
}

# ── Commands ────────────────────────────────────────

case "${1:-native}" in
    native)
        build_native "$OS" "$ARCH"
        ;;
    manifest)
        VERSION="${2:-dev}"
        generate_manifest "$VERSION" > "$ROOT/release/manifest.json"
        echo "Wrote release/manifest.json"
        cat "$ROOT/release/manifest.json"
        ;;
    all)
        # Build for current platform
        build_native "$OS" "$ARCH"
        # Cross-compile via Docker for Linux
        if [ "$OS" = "darwin" ]; then
            echo ""
            echo "Building Linux artifacts via Docker..."
            docker compose run --rm test sh -c "
                gcc $CFLAGS -shared -o /tmp/liby8_core-linux-arm64.so \
                    native/y8_qjson.c vendor/libbf/libbf.c vendor/libbf/cutils.c -lm &&
                cp /tmp/liby8_core-linux-arm64.so release/dist/
            " 2>/dev/null
            echo "  $(wc -c < "$DIST/liby8_core-linux-arm64.so") bytes"
        fi
        ;;
    *)
        echo "Usage: $0 [native|manifest|all]"
        exit 1
        ;;
esac
