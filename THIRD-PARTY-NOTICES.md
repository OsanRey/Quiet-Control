# Лицензии и границы распространения

Quiet Control — модификация Satelite. Исходный `LICENSE` Apache-2.0 и авторские
уведомления сохранены. Это не лицензия всех внешних компонентов.

| Компонент | Установленная версия | Условия |
|---|---|---|
| Satelite | baseline 1b33c42 | Apache-2.0, LICENSE в истории и дереве |
| sing-box | 1.13.18 | GPL-3.0-or-later и дополнительные условия именования из upstream LICENSE |
| Xray | 26.3.27 | MPL-2.0 |
| Mihomo | 1.19.30 | GPLv3; точные условия в upstream LICENSE |
| Wintun prebuilt | 0.14.1 | Отдельная лицензия готовых бинарных файлов |
| Microsoft CRT/WebView2 | см. portable-inputs.lock.json | Microsoft terms; отдельная проверка распространения |

Первичные источники: [sing-box](https://github.com/SagerNet/sing-box/blob/v1.13.18/LICENSE),
[Xray](https://github.com/XTLS/Xray-core/blob/v26.3.27/LICENSE),
[Mihomo](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/LICENSE),
[WebView2 distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).
Тексты лицензий ядер/Wintun находятся в `scripts/research-licenses/`.

Lock-файлы закрепляют транзитивные Rust/JS-зависимости. Инвентаризация лицензий
при уборке охватывает 355 внешних Cargo-пакетов для Windows и 107 установленных
pnpm-пакетов. Есть MIT, Apache, BSD, ISC, MPL, Unicode, CC-BY и другие лицензии;
их нельзя объединять заявлением «всё Apache». Инвентаризация metadata — не полный
аудит выполнения обязательств публичного бинарного распространения.

Публичная выдача неподписанного research portable со снимком установленного
WebView2 пока не разрешена этим аудитом. Исходники и локальные пакеты — разные
артефакты; не прикрепляйте закрытый QA ISO или research ZIP к GitHub release.
