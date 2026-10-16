#!/usr/bin/env bash
# Downloads MCR-bench (Apache-2.0, https://github.com/DeepSoftwareAnalytics/MCR-bench) into eval/data/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf data/MCR-bench && mkdir -p data
GIT_LFS_SKIP_SMUDGE=1 git -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false clone --depth 1 https://github.com/DeepSoftwareAnalytics/MCR-bench.git data/MCR-bench
ls -la data/MCR-bench/MCR-bench/dataset
