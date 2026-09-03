#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash -n "${repo_root}/docker/start-direct-sandbox.sh"
if [[ "$(uname -s)" == "Linux" ]]; then
  rootfs_helper="$(mktemp)"
  trap 'rm -f "$rootfs_helper"' EXIT
  cc -O2 -static -Wall -Wextra -Werror \
    -o "$rootfs_helper" "${repo_root}/docker/rootfs-setup.c"
fi

runtime_packages=(
  file libmagic1 jq zip unzip p7zip-full xz-utils tar
  poppler-utils qpdf ghostscript mupdf-tools
  fontconfig libfontconfig1 fonts-dejavu fonts-liberation
  fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-noto-extra
  fonts-noto-mono libharfbuzz0b libfribidi0
  librsvg2-bin imagemagick libvips-tools
  libreoffice-writer libreoffice-calc libreoffice-impress pandoc
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-por
  tesseract-ocr-ara tesseract-ocr-chi-sim tesseract-ocr-fra
  tesseract-ocr-hin tesseract-ocr-rus tesseract-ocr-osd
  sqlite3 libxml2-utils xmlstarlet ripgrep tree diffutils patch jq uchardet
  icu-devtools antiword catdoc unrtf
  libimage-exiftool-perl mediainfo pst-utils djvulibre-bin
  ffmpeg graphviz
  libcairo2 libpango-1.0-0 libpangoft2-1.0-0 libgdk-pixbuf-2.0-0
  shared-mime-info
  libblas3 liblapack3
)

python_packages=(
  pypdf pymupdf pikepdf pdfplumber weasyprint python-magic lxml
  defusedxml odfpy markdown jinja2 ocrmypdf graphviz
  csvkit extract-msg EbookLib
)

locales=(en_US es_ES pt_BR ar_SA zh_CN fr_FR hi_IN ru_RU)

for dockerfile in api/Dockerfile docker/Dockerfile.worker-sandbox; do
  for package in "${runtime_packages[@]}"; do
    grep -Eq "^[[:space:]]*${package}[[:space:]\\]*$" "${repo_root}/${dockerfile}" || {
      echo "Missing runtime package ${package} from ${dockerfile}" >&2
      exit 1
    }
  done
done

for required_mount in /etc/alternatives /etc/fonts /etc/ImageMagick-6 /etc/ImageMagick-7 /etc/libreoffice /var/cache/fontconfig; do
  grep -Fq "src: \"${required_mount}\"" "${repo_root}/api/config/sandbox.cfg" || {
    echo "Missing NsJail document resource mount: ${required_mount}" >&2
    exit 1
  }
done

grep -Fq 'exec unshare --mount /sandbox-rootfs-setup "$ROOTFS"' "${repo_root}/docker/start-direct-sandbox.sh"
for required_mount in /etc/alternatives /etc/fonts /etc/ImageMagick-6 /etc/ImageMagick-7 /etc/libreoffice /etc/ld.so.cache /var/cache/fontconfig; do
  grep -Fq "\"${required_mount}\"" "${repo_root}/docker/rootfs-setup.c" || {
    echo "Missing direct-mode document resource mount: ${required_mount}" >&2
    exit 1
  }
done
if grep -Fq 'bind_rootfs_path(rootfs, "/etc")' "${repo_root}/docker/rootfs-setup.c"; then
  echo "Direct mode must preserve the outer container's live /etc and DNS configuration" >&2
  exit 1
fi
grep -Fq 'unsetenv("LD_LIBRARY_PATH")' "${repo_root}/docker/rootfs-setup.c" || {
  echo "Direct mode must not override guest application library search paths" >&2
  exit 1
}
if grep -Eq '^[[:space:]]*setenv\("LD_LIBRARY_PATH"' "${repo_root}/docker/rootfs-setup.c"; then
  echo "Direct mode must allow applications such as LibreOffice to set private library paths" >&2
  exit 1
fi

for dockerfile in api/Dockerfile docker/Dockerfile.worker-sandbox; do
  grep -Fq 'verify-document-tooling --system' "${repo_root}/${dockerfile}"
  grep -Fq 'verify-document-tooling --python' "${repo_root}/${dockerfile}"
done

for dockerfile in api/Dockerfile docker/Dockerfile.worker-sandbox; do
  for locale in "${locales[@]}"; do
    grep -Fq "${locale}" "${repo_root}/${dockerfile}" || {
      echo "Missing locale ${locale} from ${dockerfile}" >&2
      exit 1
    }
  done
done

for package in "${python_packages[@]}"; do
  grep -Fxq "${package}" "${repo_root}/python-packages.txt" || {
    echo "Missing Python package ${package} from python-packages.txt" >&2
    exit 1
  }
done

if grep -Eiq '^pypdf2([=<>!~].*)?$' "${repo_root}/python-packages.txt"; then
  echo "Deprecated PyPDF2 must not be present in python-packages.txt" >&2
  exit 1
fi

if grep -Eq '^pdfminer([=<>!~].*)?$' "${repo_root}/python-packages.txt"; then
  echo "Legacy pdfminer conflicts with pdfminer.six" >&2
  exit 1
fi

for script in build-packages.sh docker/package-init.sh; do
  grep -Fq 'python-packages.txt' "${repo_root}/${script}"
  grep -Fq '"${PYTHON_PACKAGES[@]}"' "${repo_root}/${script}"
done

for dockerfile in api/Dockerfile docker/Dockerfile.package-init docker/Dockerfile.worker-sandbox; do
  grep -Fq 'COPY python-packages.txt /python-packages.txt' "${repo_root}/${dockerfile}" || {
    echo "Missing Python manifest copy from ${dockerfile}" >&2
    exit 1
  }
done

for dockerfile in api/Dockerfile docker/Dockerfile.worker-sandbox; do
  if grep -Fq '/usr/bin/perl*' "${repo_root}/${dockerfile}"; then
    echo "${dockerfile} removes the Perl interpreter required by ExifTool" >&2
    exit 1
  fi
done

echo "Document tooling manifests are synchronized."
