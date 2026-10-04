#!/usr/bin/env python3
"""Delete candidate artifacts left by superseded completed workflow runs.

GitHub artifact storage is a small allowance shared by every application in
this organization, so each repository keeps only the newest wave of build
candidates. Before a run stores its artifacts it removes artifacts belonging
to older completed runs of the same repository.

Artifacts of the current run and of any unfinished run are never touched, so
a build that fails before uploading cannot destroy the previous verified
wave.
"""

import json
import os
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def api(token, url, method="GET", tries=5):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lapkb-ci-artifact-prune",
    }
    last_error = None
    for attempt in range(1, tries + 1):
        try:
            call = urllib.request.Request(url, headers=headers, method=method)
            with urllib.request.urlopen(call, timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError:
            raise
        except Exception as error:  # transient network failure
            last_error = error
            time.sleep(3)
    raise RuntimeError(f"GitHub API request failed: {url}") from last_error


def api_object(token, url, method="GET"):
    data = api(token, url, method=method)
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected GitHub API response for {url}")
    return data


def completed_runs(token, base, current_run):
    runs = set()
    page = 1
    while True:
        data = api_object(token, f"{base}/actions/runs?per_page=100&page={page}")
        batch = data["workflow_runs"]
        runs.update(
            run["id"]
            for run in batch
            if run["status"] == "completed" and run["id"] != current_run
        )
        if len(batch) < 100:
            return runs
        page += 1


def superseded_artifacts(token, base, runs):
    artifacts = []
    page = 1
    while True:
        data = api_object(token, f"{base}/actions/artifacts?per_page=100&page={page}")
        batch = data["artifacts"]
        artifacts.extend(
            artifact
            for artifact in batch
            if not artifact["expired"] and artifact["workflow_run"]["id"] in runs
        )
        if len(batch) < 100:
            return artifacts
        page += 1


def main():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    repository = os.environ.get("GITHUB_REPOSITORY")
    raw_run_id = os.environ.get("GITHUB_RUN_ID")
    if not token or not repository or not raw_run_id:
        raise SystemExit("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required")
    try:
        current_run = int(raw_run_id)
    except ValueError as error:
        raise SystemExit(f"GITHUB_RUN_ID is not an integer: {raw_run_id!r}") from error
    base = f"{API}/repos/{repository}"

    runs = completed_runs(token, base, current_run)
    candidates = superseded_artifacts(token, base, runs)
    deleted = 0
    freed = 0
    for artifact in candidates:
        try:
            api(token, f"{base}/actions/artifacts/{artifact['id']}", method="DELETE")
        except urllib.error.HTTPError as error:
            if error.code != 404:  # 404 means a sibling job pruned it first
                raise
            continue
        deleted += 1
        freed += artifact["size_in_bytes"]
        print(f"Deleted superseded artifact {artifact['name']!r} ({artifact['size_in_bytes']} bytes)")

    print(
        f"Pruned {deleted} of {len(candidates)} superseded artifact(s), "
        f"freeing {freed / 1048576:.1f} MB; the current run keeps its own candidates."
    )


if __name__ == "__main__":
    main()
