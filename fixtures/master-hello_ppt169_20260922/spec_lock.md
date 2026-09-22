<!-- ppt-master-schema: spec-lock/v1 -->
# Execution Lock

## canvas
- viewBox: 0 0 1280 720
- format: ppt169

## communication
- primary_language: en
- audience: dsh-ppt-fusion maintainers
- objective: prove the deep engine renders hand-authored SVG pages to a native pptx
- core_message: the fused pipeline can mix pptwise and ppt-master pages in one deck
- consumption_mode: circulated

## mode
- mode: quick-generate

## visual_style
- visual_style: brief (pptwise theme token mirror)

## colors
- bg: #F7F6F2
- primary: #1E2A4A
- accent: #F5C518
- text: #1C1E23

## typography
- font_family: Arial
- title_family: Arial
- body_family: Arial
- body: 22
- title: 42
- caption: 12
- label: 13
- small: 14
- tiny: 15
- meta: 16
- axis: 18
- note: 20
- subhead: 26
- table_title: 32
- chart_title: 34
- value: 48
- hero: 64

## icons
- library: none
- inventory: none

## page_rhythm
- P01: cover
- P02: four-card overview
- P03: bar chart with a summary card

## pptx_structure
- mode: flat

## forbidden
- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`
- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters
