#!/usr/bin/env python3
"""Deploy the exact CI-verified commit requested by GitHub Actions."""
import argparse
import fcntl
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPOSITORY = "NekoNyangYee/Paperkit"
FILES = {"Cargo.toml", "Cargo.lock", "Dockerfile", "compose.yaml", ".dockerignore", ".env.example",
         "apps/desktop/src-tauri/Cargo.toml", "crates/pdf-core/Cargo.toml"}
REQUIRED = FILES | {"apps/backend/Cargo.toml", "deploy/deploy.sh", "deploy/smoke.py"}


def github(path):
    request = Request("https://api.github.com/repos/" + REPOSITORY + path, headers={
        "User-Agent": "paperkit-auto-deploy", "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def verified_run(runs, sha):
    matching = [run for run in runs if run.get("head_sha") == sha and run.get("head_branch") == "main"
                and run.get("event") == "push" and run.get("head_repository", {}).get("full_name") == REPOSITORY]
    latest = max(matching, key=lambda run: (run.get("run_number", 0), run.get("run_attempt", 0)), default=None)
    return latest if latest and latest.get("status") == "completed" and latest.get("conclusion") == "success" else None


def unpack(archive, target):
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            relative = PurePosixPath(*parts[1:])
            if PurePosixPath(member.name).is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe source archive path")
            name = relative.as_posix()
            if not (name in FILES or name.startswith("apps/backend/") or name.startswith("deploy/")):
                continue
            if member.isdir():
                continue
            if not member.isfile() or name in seen:
                raise ValueError("Source archive contains a link or duplicate")
            if name.endswith((".env", ".sqlite3", ".sqlite3-wal", ".sqlite3-shm")):
                raise ValueError("Source archive contains runtime data")
            total += member.size
            if member.size > 50 * 1024 * 1024 or total > 200 * 1024 * 1024:
                raise ValueError("Source archive exceeds size limit")
            seen.add(name)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as data, destination.open("wb") as output:
                shutil.copyfileobj(data, output)
            destination.chmod(0o644)
    if not REQUIRED.issubset(seen):
        raise ValueError("Source archive is incomplete")


def deploy(root, sha, run):
    with tempfile.TemporaryDirectory(prefix="paperkit-deploy-") as directory:
        directory = Path(directory)
        archive = directory / "source.tar.gz"
        request = Request(f"https://codeload.github.com/{REPOSITORY}/tar.gz/{sha}", headers={"User-Agent": "paperkit-auto-deploy"})
        with urlopen(request, timeout=60) as response, archive.open("wb") as output:
            remaining = 200 * 1024 * 1024
            while chunk := response.read(min(remaining + 1, 1024 * 1024)):
                remaining -= len(chunk)
                if remaining < 0:
                    raise ValueError("Downloaded archive exceeds size limit")
                output.write(chunk)
        stage = directory / "source"
        stage.mkdir()
        unpack(archive, stage)
        subprocess.run(["docker", "compose", "--env-file", str(root / ".env"), "-f", str(stage / "compose.yaml"), "config", "--quiet"], check=True)
        # Recheck after downloading so a newer push cannot be overwritten by a stale run.
        if github("/commits/main")["sha"] != sha:
            print("A newer main commit exists; skipping stale deployment.", flush=True)
            return
        sources = root / ".deploy-sources"
        sources.mkdir(mode=0o700, exist_ok=True)
        snapshot = sources / ("before-" + sha)
        if not snapshot.exists():
            snapshot.mkdir(mode=0o700)
            for name in ["Cargo.toml", "Cargo.lock", "Dockerfile", "compose.yaml", ".dockerignore", ".env.example", "apps", "crates", "deploy"]:
                source = root / name
                if source.is_dir():
                    shutil.copytree(source, snapshot / name)
                elif source.is_file():
                    shutil.copy2(source, snapshot / name)
        # Keep the existing .env, Docker project, database volumes and Funnel untouched.
        shutil.copytree(stage, root, dirs_exist_ok=True)
        subprocess.run(["bash", str(root / "deploy/deploy.sh")], cwd=root, check=True, timeout=2400)
        port = next((line.split("=", 1)[1] for line in (root / ".env").read_text().splitlines() if line.startswith("PROXY_PORT=")), "")
        if not port.isdigit():
            raise ValueError("Invalid proxy port")
        subprocess.run(["python3", str(root / "deploy/smoke.py"), f"http://127.0.0.1:{port}/paperkit"], check=True)
        subprocess.run(["python3", str(root / "deploy/smoke.py"), "https://thkim.tail969319.ts.net/paperkit"], check=True)
        state = {"sha": sha, "workflowRun": run["html_url"]}
        pending = root / ".deploy-state.tmp"
        pending.write_text(json.dumps(state) + "\n")
        pending.replace(root / ".deploy-state.json")
        print(f"Deployment healthy: {sha}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--sha", required=True, help="Exact CI-verified main commit supplied by Actions")
    parser.add_argument("--check", action="store_true", help="Check CI without modifying the running service")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if not (root / ".env").is_file():
        parser.error("Deployment root must already contain .env")
    with (root / ".deploy.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        sha = args.sha
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("Invalid main commit")
        if github("/commits/main")["sha"] != sha:
            print("A newer main commit exists; skipping stale deployment.", flush=True)
            return
        state_path = root / ".deploy-state.json"
        if state_path.exists() and json.loads(state_path.read_text()).get("sha") == sha:
            print(f"Already deployed: {sha}", flush=True)
            return
        query = urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 10})
        try:
            runs = github("/actions/workflows/backend.yml/runs?" + query)["workflow_runs"]
        except HTTPError as error:
            if error.code != 404:
                raise
            runs = []
        run = verified_run(runs, sha)
        if not run:
            raise RuntimeError(f"Successful backend CI is required before deployment: {sha}")
        elif args.check:
            print(f"Ready to deploy: {sha}", flush=True)
        else:
            deploy(root, sha, run)


if __name__ == "__main__":
    main()
