# GTA6 Voice — состояние проекта на 22 ноября 2026

## Актуальные ссылки
- Репозиторий: https://github.com/Deaziii/Gta6Voice
- Ветка: main
- GitHub Pages: https://deaziii.github.io/Gta6Voice/
- Последняя опубликованная версия: 0.51
- Deployment run #140: https://github.com/Deaziii/Gta6Voice/actions/runs/45014804225
- Версия 0.51 опубликована успешно (GitHub Actions: conclusion=success).

## Что подтверждено пользователем
- В версии 0.35 после перехода на PaddleOCR русское распознавание стало хорошим.
- После возврата к штатному WASM runtime в версии 0.50 сканирование заработало, озвучка тоже заработала.
- В версии 0.51 ещё не получено подтверждение, что новая политика очереди устранила отставание и дубли.

## Архитектура
- Frontend: HTML/CSS/JavaScript + Vite, GitHub Pages.
- OCR: @paddleocr/paddleocr-js 0.4.2.
- Detector: PP-OCRv5_mobile_det.
- Recognition: eslav_PP-OCRv5_mobile_rec (East Slavic, включая русский).
- Русский recognition model tar готовится во время GitHub Actions build.
- Inference: штатный PaddleOCR.js ONNX Runtime, backend wasm, numThreads 1, SIMD.
- Worker mode включён.
- Camera: navigator.mediaDevices.getUserMedia, facingMode environment.
- OCR preprocessing: camera frame scaled to max width 1280; ROI crop; upscaling ~1.8x; grayscale and contrast 1.35.
- TTS: browser SpeechSynthesis, lang ru-RU, selectable device voices, rate/volume controls.
- Build: Vite, base path /Gta6Voice/.

## Текущая проблема пользователя
Пользователь говорит:
1. Если реплики быстро сменяются — озвучка не успевает.
2. При двухстрочных субтитрах бывают повторы или чтение с задержкой.
3. Очередь накапливалась и потом произносила старые реплики, когда сюжет уже ушёл вперёд.

## Что уже сделано в v0.51 (пока не подтверждено на устройстве)
- Максимум один pending item в speech queue; новые независимые реплики заменяют ожидающую.
- Pending item старше 3 секунд отбрасывается при старте проигрывания.
- Добавлен captionRelation: same / extension / partial / new для выявления добавления второй строки к первой.
- Если новая caption — расширение активной/предыдущей строки, пытается произнести только delta, чтобы не повторить предыдущую часть.
- Если pending ещё не произнесён, новый более полный caption должен обновить его.
- Временное dedupe окно сокращено примерно до 1.8 секунды.
- Модель OCR, preprocessing и WASM runtime в v0.51 не менялись по сравнению с рабочей конфигурацией.

## Технические ограничения
- OCR проходит последовательно; время одного полного inference — основной latency. Очередь не может ускорить OCR.
- SpeechSynthesis Android произносит последовательно. Если длительность TTS больше времени показа subtitle, невозможно произнести абсолютно всё без пропуска/объединения/увеличения скорости.
- Не обещать "мгновенно" без тестовых измерений на реальном Android.
- WebGPU experiments (v0.39–0.49) не дали правильного детектирования на телефоне. В 0.50 от них отказались.
- Не восстанавливать самодельный shim/hybrid v0.49. Он удалён в v0.50.
- PP-OCRv6 Tiny detector (v0.48) также не решил проблему. В v0.50 вернули PP-OCRv5 detector.

## Известные директории/файлы в репозитории
- app.js — камера, crop, OCR loop, parser, speech queue, TTS.
- index.html — разметка и version/cache-busting.
- styles.css — стили/ROI overlay/mobile UI.
- package.json — зависимости.
- vite.config.js — Vite config.
- README.md — краткое описание.
- .github/workflows/pages.yml — model preparation/build/deploy workflow.
- HANDOFF/ — эта документация и prompt для следующего ИИ.

## Важные правила разработки
- Сначала читать актуальные файлы и commit, не полагаться только на handoff.
- Все правки делать маленькими и проверяемыми.
- Всегда fetch актуальный SHA файла перед update; после изменений перечитать файл.
- Следить за GitHub Actions build + Deploy conclusion success до сообщения, что опубликовано.
- Не менять OCR backend/model и очередь одновременно.
- Не путать подтверждение GitHub build с тестом на Android.
