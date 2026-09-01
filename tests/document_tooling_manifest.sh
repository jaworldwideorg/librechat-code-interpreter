#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash -n "${repo_root}/docker/start-direct-sandbox.sh"
grep -Fq '    hash -r' "${repo_root}/docker/start-direct-sandbox.sh"

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
  icu-devtools antiword catdoc unrtf ffmpeg graphviz
  libcairo2 libpango-1.0-0 libpangoft2-1.0-0 libgdk-pixbuf-2.0-0
  shared-mime-info
  libblas3 liblapack3
)

python_packages=(
  pypdf pymupdf pikepdf pdfplumber weasyprint python-magic lxml
  defusedxml odfpy markdown jinja2 ocrmypdf graphviz
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

for required_mount in /etc/alternatives /etc/fonts /etc/ImageMagick-7 /etc/libreoffice /var/cache/fontconfig; do
  grep -Fq "src: \"${required_mount}\"" "${repo_root}/api/config/sandbox.cfg" || {
    echo "Missing NsJail document resource mount: ${required_mount}" >&2
    exit 1
  }
done

grep -Fq 'mount_safe -o bind,ro "$ROOTFS/usr" /usr' "${repo_root}/docker/start-direct-sandbox.sh"
grep -Fq 'for etc_path in alternatives fonts ImageMagick-7 libreoffice' "${repo_root}/docker/start-direct-sandbox.sh"
grep -Fq '"$ROOTFS/etc/ld.so.cache" /etc/ld.so.cache' "${repo_root}/docker/start-direct-sandbox.sh"
if grep -Fq 'mount_safe -o bind,ro "$ROOTFS/etc" /etc' "${repo_root}/docker/start-direct-sandbox.sh"; then
  echo "Direct mode must preserve the outer container's live /etc and DNS configuration" >&2
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
