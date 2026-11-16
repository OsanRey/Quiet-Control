# Сборка Quiet Control

Исходники находятся в корне этого Git-репозитория. React/TypeScript — `src/`,
Rust/Tauri — `src-tauri/`, ресурсы — `src-tauri/resources/`, сценарии — `scripts/`.
Сборка рассчитана на Windows 11 x64. Остальные платформы унаследованы от Satelite,
но для этого форка не приняты как проверенные.

Нужны Node.js 22 LTS или совместимый Node, pnpm 11, стабильный Rust MSVC,
Visual Studio Build Tools с C++/Windows SDK. Сохраните `pnpm-lock.yaml` и
`src-tauri/Cargo.lock`. Установка зависимостей не должна обновлять lock-файлы.

```powershell
pnpm install --frozen-lockfile --registry https://registry.npmjs.org
pnpm build
$env:CARGO_INCREMENTAL='0'
$env:CARGO_PROFILE_DEV_DEBUG='0'
cargo build --locked --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
```

Для офлайн-сборки предварительно заполните pnpm/Cargo caches; добавьте `--offline`.
Офлайн-восстановление pnpm может требовать не только tarball, но и registry metadata.
Режим `CARGO_PROFILE_DEV_DEBUG=0` уменьшает артефакты, не меняя сетевые настройки.
Это всё ещё неподписанная экспериментальная dev-сборка, а не стабильный релиз.

## Полный локальный portable

`scripts/package-research-portable.py` получает отдельный каталог входов,
сверяет каждый файл с `scripts/portable-inputs.lock.json`, добавляет собранный EXE,
создаёт архив и независимо проверяет SHA-256 распакованных файлов.

```powershell
python scripts/package-research-portable.py --edition quiet-control-unified-nodes `
  --inputs /path/to/reviewed-inputs --exe /path/to/satelite-proxy.exe `
  --out /path/to/private-artifacts
```

Входы включают закреплённые sing-box 1.13.18, Xray 26.3.27, Mihomo 1.19.30,
Wintun, CRT и WebView2. Lock хранит версии/контрольные суммы, но не является
разрешением на распространение. Локальная исследовательская копия WebView2 —
снимок установленного Microsoft runtime, не официальный Fixed Version CAB.
Она сохранена локально для воспроизводимости и не предназначена для GitHub assets.
Перед публичным бинарным релизом нужен отдельный проверенный путь получения и
распространения Microsoft runtime и выполнение обязательств лицензий ядер.

Для локального воспроизведения в исследовательском workspace используются
`research/runtime/stage` и общий `research/artifacts/satelite-target`.
Все входы храните вне Git. Пользовательские данные/подписки в пакет не добавляются.

## Проверка

```powershell
node scripts/quiet-control/unified-nodes-test.mjs
node scripts/quiet-control/latency-display-test.mjs
cargo test --locked --lib unified_ --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

Не запускайте сетевые ядра/TUN на основной Windows ради автоматической приёмки.
Нативный запуск и проверка основных страниц выполняются в отдельной Windows VM.
Успешная компиляция не считается доказательством работы интернета, TUN или DNS.
