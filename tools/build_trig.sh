#!/bin/sh
# Rebuilds Year 9 Trigonometry 3E-3I end to end.
#
# The answers step must follow the chapter build, because building the
# chapter rewrites workbook.json from scratch and would drop them.
set -e
PDF="${1:?usage: build_trig.sh CHAPTER.pdf ANSWERS.pdf}"
ANS="${2:?usage: build_trig.sh CHAPTER.pdf ANSWERS.pdf}"
ID=0a1ff8d9fd53

python3 tools/extract_flow.py --pdf "$PDF" --pages 0-32 \
  --title "Year 9 - Chapter 3: Trigonometry (3E-3I)" --prefix tg_ --project-id "$ID"

python3 tools/add_answers.py --pdf "$ANS" --project-id "$ID" \
  --section "3E=17:L:588-706,17:R:46-706,18:L:46-448" \
  --section "3F=18:L:448-706,18:R:46-322" \
  --section "3G=18:R:445-706,19:L:46-255" \
  --section "3H=19:L:255-706" \
  --section "3I=19:R:46-618"
