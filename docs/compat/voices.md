# Narration voices (edge-tts)

Recorded from `ppt-master notes-to-audio --list-common-voices` on 2026-09-22 with
`ppt-master 0.1.128` and `edge-tts 7.2.8`. The list is the engine's curated subset: it is
offline (no provider query), so it is the list to quote in docs. `--list-voices` asks the
provider for the full catalogue and needs network.

`dsh-ppt narrate <deck> --voice <name>` passes the name through; `edge` is the default
provider and needs no API key. Other providers (elevenlabs, minimax, qwen, cosyvoice) read
their own credentials from the environment, which the runner only forwards when the caller
allow-lists them (ADR-019).

```text
Common edge-tts voices:
Locale   Voice                         Notes
------   ----------------------------  ----------------
zh-CN    zh-CN-XiaoxiaoNeural          女声，普通话，清晰自然，默认推荐
zh-CN    zh-CN-XiaoyiNeural            女声，普通话，明亮
zh-CN    zh-CN-YunjianNeural           男声，普通话，稳重
zh-CN    zh-CN-YunxiNeural             男声，普通话，年轻
zh-CN    zh-CN-YunxiaNeural            男声，普通话，少年感
zh-CN    zh-CN-YunyangNeural           男声，普通话，播报感
zh-HK    zh-HK-HiuGaaiNeural           女声，粤语
zh-HK    zh-HK-WanLungNeural           男声，粤语
zh-TW    zh-TW-HsiaoChenNeural         女声，台湾普通话
zh-TW    zh-TW-YunJheNeural            男声，台湾普通话
en-US    en-US-JennyNeural             女声，美式英语
en-US    en-US-GuyNeural               男声，美式英语
en-GB    en-GB-SoniaNeural             女声，英式英语
en-GB    en-GB-RyanNeural              男声，英式英语
```
