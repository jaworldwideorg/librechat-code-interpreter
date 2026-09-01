#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

runtime_packages=(
  file libmagic1 jq zip unzip p7zip-full xz-utils tar
  poppler-utils qpdf ghostscript mupdf-tools
  fontconfig libfontconfig1 fonts-dejavu fonts-liberation
  librsvg2-bin imagemagick libvips-tools
  libreoffice-writer libreoffice-calc libreoffice-impress pandoc
  tesseract-ocr tesseract-ocr-eng ffmpeg graphviz
  libcairo2 libpango-1.0-0 libpangoft2-1.0-0 libgdk-pixbuf-2.0-0
  shared-mime-info
)

python_packages=(
  pypdf pymupdf pikepdf pdfplumber weasyprint python-magic lxml
  defusedxml odfpy markdown jinja2 ocrmypdf graphviz
)

for dockerfile in api/Dockerfile docker/Dockerfile.worker-sandbox; do
  for package in "${runtime_packages[@]}"; do
    grep -Eq "^[[:space:]]*${package}[[:space:]\\]*$" "${repo_root}/${dockerfile}" || {
      echo "Missing runtime package ${package} from ${dockerfile}" >&2
      exit 1
    }
  done
done

for script in build-packages.sh docker/package-init.sh; do
  for package in "${python_packages[@]}"; do
    grep -Eq "^[[:space:]]*${package}[[:space:]\\]*$" "${repo_root}/${script}" || {
      echo "Missing Python package ${package} from ${script}" >&2
      exit 1
    }
  done

  if grep -Eq '^[[:space:]]*pdfminer[[:space:]\\]*$' "${repo_root}/${script}"; then
    echo "Legacy pdfminer conflicts with pdfminer.six in ${script}" >&2
    exit 1
  fi
done

echo "Document tooling manifests are synchronized."
