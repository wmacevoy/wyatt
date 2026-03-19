#!/usr/bin/env python3
"""Fetch y8-core artifacts by manifest hash.

Usage:
    python3 release/fetch.py                    # fetch for current platform
    python3 release/fetch.py --verify-only      # verify existing artifacts

Reads release/manifest.json, downloads artifacts to release/dist/,
verifies SHA256 hashes.
"""

import json
import os
import hashlib
import sys
import platform
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "release", "manifest.json")
DIST = os.path.join(ROOT, "release", "dist")


def load_manifest():
    with open(MANIFEST) as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def platform_key():
    """Return the artifact key for the current platform."""
    s = platform.system().lower()
    m = platform.machine().lower()
    os_name = "darwin" if s == "darwin" else "linux"
    arch = "arm64" if m in ("arm64", "aarch64") else "x64"
    ext = "dylib" if os_name == "darwin" else "so"
    return "liby8_core-%s-%s.%s" % (os_name, arch, ext)


def fetch_artifact(name, info):
    os.makedirs(DIST, exist_ok=True)
    path = os.path.join(DIST, name)

    # Check if already exists and valid
    if os.path.exists(path):
        actual = sha256_file(path)
        if actual == info["sha256"]:
            print("  %s: OK (cached)" % name)
            return True
        print("  %s: hash mismatch, re-downloading" % name)

    # Download
    url = info["url"]
    print("  %s: fetching %s ..." % (name, url))
    try:
        urllib.request.urlretrieve(url, path)
    except Exception as e:
        print("  %s: FAILED (%s)" % (name, e))
        return False

    # Verify
    actual = sha256_file(path)
    if actual != info["sha256"]:
        print("  %s: HASH MISMATCH" % name)
        print("    expected: %s" % info["sha256"])
        print("    got:      %s" % actual)
        os.remove(path)
        return False

    print("  %s: OK (%d bytes)" % (name, os.path.getsize(path)))
    return True


def main():
    verify_only = "--verify-only" in sys.argv

    manifest = load_manifest()
    print("y8-core v%s" % manifest.get("version", "?"))

    key = platform_key()
    artifacts = manifest.get("artifacts", {})

    if key not in artifacts:
        print("No artifact for platform: %s" % key)
        print("Available: %s" % ", ".join(artifacts.keys()))
        sys.exit(1)

    if verify_only:
        path = os.path.join(DIST, key)
        if not os.path.exists(path):
            print("  %s: NOT FOUND" % key)
            sys.exit(1)
        actual = sha256_file(path)
        expected = artifacts[key]["sha256"]
        if actual == expected:
            print("  %s: OK" % key)
        else:
            print("  %s: HASH MISMATCH" % key)
            sys.exit(1)
    else:
        if not fetch_artifact(key, artifacts[key]):
            sys.exit(1)


if __name__ == "__main__":
    main()
