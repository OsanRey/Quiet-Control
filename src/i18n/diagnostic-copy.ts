// Display-only adapter for known upstream DNS diagnostic copy. User names stay untouched.
export const diagnosticCopy = [
 ['内核未运行，仅展示配置路径','Ядро остановлено; показан путь из конфигурации','Core stopped; showing configured path'],
 ['Xray 内核无 DNS 查询 API，仅展示配置路径','У Xray нет API DNS-запросов; показан путь из конфигурации','Xray has no DNS query API; showing configured path'],
 ['当前配置未启用 Clash API，无法实时查询','В конфигурации выключен Clash API; запрос в реальном времени недоступен','Clash API is disabled; live queries are unavailable'],
 ['自定义配置：查询路径推演不可用（配置非应用生成）','Готовая конфигурация: приложение не может вычислить путь запроса','Raw custom configuration: path analysis is unavailable'],
 ['TUN + FakeIP 启用：A 查询可能由 fakedns 池直接应答','TUN и FakeIP включены: ответы A могут поступать непосредственно из пула fakedns','TUN and FakeIP enabled: A queries may be answered by the fakedns pool'],
 ['mihomo 并发竞速整池','Mihomo опрашивает серверы пула параллельно','Mihomo races the server pool concurrently'],
 ['fake-ip-filter 内的后缀走真实解析','Суффиксы из fake-ip-filter разрешаются в настоящие IP','Suffixes in fake-ip-filter use real IP resolution'],
 ['Hosts 静态映射（精确域名）','Статическое соответствие Hosts (точный домен)','Static Hosts mapping (exact domain)'],
 ['关键词规则在 mihomo 下无 DNS 策略形式','Правила по ключевым словам в Mihomo не задают стратегию DNS','Keyword rules have no DNS strategy representation in Mihomo'],
 ['回落默认解析','используется DNS по умолчанию','falling back to default DNS'],
 ['静态映射','статическое соответствие','static mapping'],
 ['经代理出口','через прокси','via proxy'],['经主出站','через основной выход','via main outbound'],
 ['UDP 明文','UDP без шифрования','plaintext UDP'],['系统解析','системный DNS','system DNS'],
 ['经代理','через прокси','via proxy'],['直连','напрямую','direct'],
 ['Xray 池内顺序回退','Последовательный выбор DNS в пуле Xray','Sequential DNS fallback in Xray'],
 ['无备援','без резервного сервера','no backup'],['备援','резерв','backup'],
 ['FakeIP 池','Пул FakeIP','FakeIP pool'],['默认解析','DNS по умолчанию','default DNS'],
 ['FakeIP 旁路后缀','Суффикс без FakeIP','FakeIP bypass suffix'],
 ['FakeIP 启用','FakeIP включён','FakeIP enabled'],['查询','запрос','query'],
 ['规则集','Набор правил','Rule set'],['DNS 规则','Правило DNS','DNS rule'],
 ['精确','точное совпадение','exact'],['后缀','суффикс','suffix'],['关键词','ключевое слово','keyword'],
 ['的成员按本地缓存近似判定，内核以自身数据为准','оценивается по локальному кешу; данные ядра имеют приоритет','is approximated from local cache; the core data is authoritative'],
] as const;
export const diagnosticEn = Object.fromEntries(diagnosticCopy.map((v,i)=>['diag.'+i,v[2]])) as Record<`diag.${number}`,string>;
export const diagnosticRu = Object.fromEntries(diagnosticCopy.map((v,i)=>['diag.'+i,v[1]])) as Record<`diag.${number}`,string>;
