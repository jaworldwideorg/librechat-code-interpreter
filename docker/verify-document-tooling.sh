#!/bin/sh
set -eu

mode="${1:---system}"

require_commands() {
    for command_name in "$@"; do
        command -v "$command_name" >/dev/null 2>&1 || {
            echo "Missing document tool: $command_name" >&2
            exit 1
        }
    done
}

check_resources() {
    require_commands \
        file jq zip unzip 7z xz tar \
        pdfinfo pdftotext pdftoppm pdffonts pdfimages qpdf gs mutool \
        fc-match rsvg-convert magick convert identify vips libreoffice pandoc \
        tesseract sqlite3 xmllint xmlstarlet rg tree diff patch uchardet icuinfo \
        antiword catdoc unrtf exiftool mediainfo readpst cjb2 ddjvu \
        ffmpeg ffprobe dot

    test -r /etc/fonts/fonts.conf
    test -d /usr/share/fonts
    test -d /var/cache/fontconfig
    test -d /usr/share/tesseract-ocr/5/tessdata
    test -r /usr/share/tesseract-ocr/5/tessdata/eng.traineddata
    pandoc --print-default-data-file=abbreviations >/dev/null
    gs -q -dNOPAUSE -dBATCH -sDEVICE=nullpage -c quit

    for family in \
        "Noto Sans" "Noto Sans Arabic" "Noto Sans Devanagari" \
        "Noto Sans CJK SC" "Noto Color Emoji" "Noto Sans Mono" \
        "Liberation Sans" "DejaVu Sans"; do
        matched_font="$(fc-match -f '%{file}\n' "$family" | head -n 1)"
        test -r "$matched_font" || {
            echo "Fontconfig cannot resolve: $family" >&2
            exit 1
        }
    done

    available_languages="$(tesseract --list-langs 2>/dev/null)"
    for language in eng spa por ara chi_sim fra hin rus osd; do
        printf '%s\n' "$available_languages" | grep -qx "$language" || {
            echo "Missing Tesseract language: $language" >&2
            exit 1
        }
    done

    if ldd /usr/bin/ffmpeg /usr/bin/ffprobe 2>&1 | grep -q 'not found'; then
        echo "FFmpeg has unresolved shared-library dependencies" >&2
        exit 1
    fi
}

check_resources

if [ "$mode" = "--readiness" ]; then
    exit 0
fi

work_dir="$(mktemp -d /tmp/document-tooling.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT INT TERM

if [ "$mode" = "--system" ]; then
    export HOME="$work_dir/home"
    export XDG_RUNTIME_DIR="$work_dir/runtime"
    export SAL_USE_VCLPLUGIN=svp
    mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$work_dir/output"
    chmod 700 "$XDG_RUNTIME_DIR"

    printf '%s\n' '# JA Worldwide' 'English Español Português العربية 中文 Français हिन्दी Русский' \
        > "$work_dir/document.md"
    printf '%s\n' 'name,value' 'JA Worldwide,1' > "$work_dir/workbook.csv"

    pandoc "$work_dir/document.md" -o "$work_dir/document.docx"
    pandoc "$work_dir/document.md" -o "$work_dir/presentation.pptx"
    pandoc "$work_dir/document.docx" -o "$work_dir/document.html"
    test -s "$work_dir/document.html"

    libreoffice --headless --nologo --nodefault --nofirststartwizard --nolockcheck \
        "-env:UserInstallation=file://$work_dir/lo-profile" \
        --convert-to xlsx --outdir "$work_dir" "$work_dir/workbook.csv" >/dev/null

    for office_file in document.docx presentation.pptx workbook.xlsx; do
        stem="${office_file%.*}"
        profile="$work_dir/lo-${stem}"
        libreoffice --headless --nologo --nodefault --nofirststartwizard --nolockcheck \
            "-env:UserInstallation=file://$profile" \
            --convert-to pdf --outdir "$work_dir/output" "$work_dir/$office_file" >/dev/null
        test -s "$work_dir/output/$stem.pdf"
        qpdf --check "$work_dir/output/$stem.pdf" >/dev/null
        gs -q -dNOPAUSE -dBATCH -sDEVICE=nullpage "$work_dir/output/$stem.pdf"
    done

    printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="5" y="25">JA</text></svg>' \
        | rsvg-convert -f png > "$work_dir/vector.png"
    identify "$work_dir/vector.png" | grep -q PNG
    magick "$work_dir/vector.png" "$work_dir/vector.webp"
    test -s "$work_dir/vector.webp"
    exiftool -FileType "$work_dir/vector.webp" | grep -q WEBP

    printf '%s\n' 'P1' '2 2' '0 1' '1 0' > "$work_dir/monochrome.pbm"
    cjb2 "$work_dir/monochrome.pbm" "$work_dir/document.djvu"
    ddjvu -format=ppm "$work_dir/document.djvu" "$work_dir/document.ppm"
    test -s "$work_dir/document.ppm"

    printf '%s\n' 'digraph G { input -> output }' | dot -Tsvg > "$work_dir/graph.svg"
    test -s "$work_dir/graph.svg"

    noto_sans_font="$(fc-match -f '%{file}' 'Noto Sans')"
    magick -size 700x120 xc:white -fill black -font "$noto_sans_font" -pointsize 48 \
        -gravity center -annotate 0 'HELLO WORLD' "$work_dir/ocr.png"
    tesseract "$work_dir/ocr.png" stdout -l eng 2>/dev/null | grep -q 'HELLO WORLD'

    ffmpeg -loglevel error -f lavfi -i sine=frequency=1000:duration=0.1 \
        "$work_dir/tone.wav"
    ffprobe -v error -show_entries format=duration -of default=nw=1 "$work_dir/tone.wav" \
        | grep -q '^duration='
    mediainfo --Output=JSON "$work_dir/tone.wav" | jq -e '.media.track | length > 0' >/dev/null
    readpst -V >/dev/null

    exit 0
fi

if [ "$mode" = "--python" ]; then
    python_bin="$(find -L /pkgs/python -mindepth 3 -maxdepth 3 -type f -path '*/bin/python3' -print -quit)"
    test -n "$python_bin"
    python_dir="$(dirname "$python_bin")"

    "$python_bin" -c 'import csvkit, ebooklib, extract_msg, importlib.util, magic, ocrmypdf, pikepdf, pymupdf, pypdf, weasyprint; assert importlib.util.find_spec("PyPDF2") is None'
    "$python_bin" -c \
        'from ebooklib import epub; book = epub.EpubBook(); book.set_identifier("ja"); book.set_title("JA Worldwide"); book.set_language("en"); chapter = epub.EpubHtml(title="Document", file_name="document.xhtml"); chapter.content = "<h1>JA Worldwide</h1>"; book.add_item(chapter); book.spine = ["nav", chapter]; epub.write_epub("'"$work_dir"'/document.epub", book)'
    test -s "$work_dir/document.epub"
    printf '%s\n' 'name,value' 'JA Worldwide,1' > "$work_dir/table.csv"
    "$python_dir/csvcut" -c name "$work_dir/table.csv" | grep -q 'JA Worldwide'
    "$python_bin" -c \
        'from weasyprint import HTML; HTML(string="<h1>JA Worldwide</h1><p>Español العربية 中文 हिन्दी Русский</p>").write_pdf("'"$work_dir"'/weasyprint.pdf")'
    test -s "$work_dir/weasyprint.pdf"
    qpdf --check "$work_dir/weasyprint.pdf" >/dev/null

    noto_sans_font="$(fc-match -f '%{file}' 'Noto Sans')"
    magick -size 900x160 xc:white -fill black -font "$noto_sans_font" -pointsize 56 \
        -gravity center -annotate 0 'SEARCHABLE DOCUMENT' "$work_dir/scan.png"
    "$python_dir/img2pdf" --imgsize 6inx1in "$work_dir/scan.png" -o "$work_dir/scan.pdf"
    "$python_dir/ocrmypdf" --force-ocr --output-type pdf \
        "$work_dir/scan.pdf" "$work_dir/searchable.pdf" >/dev/null
    test -s "$work_dir/searchable.pdf"
    pdftotext "$work_dir/searchable.pdf" - | grep -q 'SEARCHABLE DOCUMENT'
    exit 0
fi

echo "usage: $0 [--readiness|--system|--python]" >&2
exit 64
