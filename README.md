# jellyfin-torrent-streamer

[English documentation](README.en.md)

Windows-утилита на Node.js, которая импортирует `.torrent` в локальный TorrServer и создаёт `.strm`-медиатеку для Jellyfin. Jellyfin получает обычный HTTP-поток с поддержкой перемотки, а полный видеофайл заранее не скачивается.

> Используйте проект только для контента, который вы вправе получать и раздавать. Сам проект не содержит каталога контента, торрент-файлов или TorrServer.

## Как это работает

```text
data\inbox
    │  импорт .torrent
    ▼
TorrServer на 127.0.0.1:8090 ──► циклический дисковый кэш
    │
    ├── архив .torrent в data\processed
    └── .strm в movies / tv
                  │
                  ▼
Jellyfin ──► http://LAN-IP:8091/stream/<token>/<hash>/<index>/<file>
                  │
                  └── шлюз проверяет токен и проксирует GET/HEAD/Range
```

Основной процесс каждые 10 секунд проверяет `data\inbox` и ждёт 2 секунды, пока размер нового файла перестанет меняться. После успешного импорта торрент перемещается в `data\processed`, после ошибки — в `data\failed`. Атомарный реестр `data\state\imports.json` не даёт создавать дубликаты и позволяет восстановить ссылки из архива.

TorrServer слушает API только на `127.0.0.1:8090`. В локальную сеть публикуется только ограниченный потоковый шлюз на порту `8091`. Он принимает `GET`, `HEAD` и `Range`; поэтому Jellyfin может начинать просмотр и перематывать, не дожидаясь полной загрузки.

TorrServer загружает необходимые куски файла и хранит их в дисковом кэше. Встроенный LRU-контроллер утилиты раз в пять минут измеряет весь `paths.cache` и при превышении `cacheSizeBytes` удаляет старейшие каталоги неактивных торрентов. Активные потоки не удаляются, поэтому во время просмотра целевой размер может быть временно превышен.

## Требования

- Windows 10 или 11 x64;
- Node.js 20 или новее;
- Jellyfin и шлюз на одном компьютере;
- доступ клиентов к этому компьютеру по доверенной локальной сети;
- PowerShell 5.1 или 7;
- сиды для импортированного торрента.

Сторонние npm-пакеты не используются. Установщик отдельно загружает официальный `TorrServer-windows-amd64.exe` версии `MatriX.142.2` и проверяет SHA-256, опубликованный GitHub Release. Бинарник не входит в Git и release ZIP.

## Быстрая установка

Откройте PowerShell от имени администратора, если нужны автозапуск и Firewall:

```powershell
git clone https://github.com/nelidgc/jellyfin-torrent-streamer.git
cd jellyfin-torrent-streamer

Set-ExecutionPolicy -Scope Process Bypass

.\install.ps1 `
  -LibraryPath "D:\MediaServer\media" `
  -CachePath "D:\TorrServerCache" `
  -CacheSizeGB 20 `
  -ConfigureFirewall `
  -RegisterTask
```

Если LAN-адрес определился неверно, укажите физический IPv4 явно:

```powershell
.\install.ps1 -LanAddress "192.168.1.20" -ConfigureFirewall -RegisterTask
```

Установщик:

- создаёт `config.json` только при первой установке;
- генерирует случайный 256-битный токен шлюза;
- применяет `LibraryPath`, `CachePath`, `CacheSizeGB` и `LanAddress`, только если они переданы явно;
- создаёт правило `Jellyfin Torrent Stream Gateway` для TCP 8091, `LocalSubnet`, профиль `Any`;
- регистрирует задачу `Jellyfin Torrent Streamer` от `SYSTEM` при `-RegisterTask`;
- скачивает TorrServer из закреплённого официального релиза и отказывается запускать непроверенный файл.

Повторный запуск без параметров путей сохраняет существующий `config.json`, архив и состояние. `-Force` разрешает заменить только локальный `TorrServer.exe`, если его хэш отличается; пользовательские данные он не удаляет.

По умолчанию закреплена версия `MatriX.142.2`. Для проверенного обновления можно одновременно передать собственные `-TorrServerVersion MatriX.X` и `-TorrServerSha256 <64-символьный-SHA256>`. Один параметр без второго отклоняется; хэш нужно брать из официального GitHub Release.

Установщик лишь предупреждает о широких входящих правилах Windows Firewall для `Node.js`. Отключить их можно только явно:

```powershell
.\install.ps1 -RestrictBroadNodeFirewall
```

## Настройка Jellyfin

После установки выполните:

```powershell
node .\torrent-jellyfin.mjs doctor
```

В панели Jellyfin создайте две отдельные библиотеки:

- тип «Фильмы», путь `<paths.library>\<library.moviesFolder>`;
- тип «Сериалы», путь `<paths.library>\<library.showsFolder>`.

Для примера из команды установки это:

- `D:\MediaServer\media\movies`;
- `D:\MediaServer\media\tv`.

Имена `S01E02`, `S01.E02` и `1x02` распознаются как эпизоды и раскладываются в `tv\Название\Season 01`. При импорте удаляются tracker/domain-префиксы, `rutracker-ID` и релизные хвосты (`2160p`, `WEB-DL`, кодек, HDR и другие технические теги). Эпизод получает стандартное имя `Название - S01E02.strm`, а фильм — `Название (Год)\Название (Год).strm`; это помогает Jellyfin находить метаданные.

`library.titlePreference` управляет источником названия. Публичное значение `metadata` всегда предпочитает очищенный `status.name` TorrServer. `localized` выбирает вариант на родном письме только тогда, когда не-латинские буквы есть ровно в одном из кандидатов (`status.name`, `status.title`, имя `.torrent`); при неоднозначности снова используется metadata. После смены режима сначала используйте dry-run.

Признак «родного письма» — не-латинские буквы, а не просто не-ASCII: кириллица, греческий, иврит, арабский, японский, корейский, китайский, грузинский считаются родным письмом, а `Amélie` и `Das Boot` остаются обычной латиницей и не участвуют в этом выборе.

По той же причине из двойного названия вида `Родное название / International Title` в имя каталога попадает только родная половина — для любого не-латинского письма, а не только для кириллицы.

Нераспознанные дополнительные видео сериала попадают в `Extras`. `rebuild` переносит управляемые ссылки на новую схему и удаляет старые только после проверки их hash и индекса. Изменённые пользователем файлы не удаляются и не перезаписываются; при конфликте к имени добавляется короткий infohash.

## Импорт и команды

Положите `.torrent` в `data\inbox` или импортируйте его напрямую:

```powershell
node .\torrent-jellyfin.mjs import "D:\Downloads\example.torrent"
```

Основные команды:

```powershell
node .\torrent-jellyfin.mjs run
node .\torrent-jellyfin.mjs doctor
node .\torrent-jellyfin.mjs rebuild --dry-run
node .\torrent-jellyfin.mjs rebuild
node .\torrent-jellyfin.mjs import "file.torrent"
```

Если конфигурация находится не рядом со скриптом, добавьте `--config`:

```powershell
node .\torrent-jellyfin.mjs doctor --config "D:\Config\torrent-streamer.json"
```

`rebuild --dry-run` не изменяет `.strm`, реестр или TorrServer. Он строит план из реестра (и доступных метаданных TorrServer) и атомарно сохраняет его в `paths.state\rebuild-preview.json`; другой файл можно указать через `--report`. В отчёте есть старый/новый путь, hash, индекс, источник названия и действие. Обычный `rebuild` сначала сохраняет резервную копию `imports.json`, повторяет проверку плана и отказывается продолжать при ошибках, выходе за медиатеку, риске перезаписи пользовательских файлов или изменении количества управляемых записей.

## Каталоги и конфигурация

Все локальные настройки находятся в игнорируемом Git файле `config.json`. Стандартная структура:

| Назначение | Стандартный путь | Настройка |
|---|---|---|
| Новые торренты | `data\inbox` | `paths.inbox` |
| Архив торрентов | `data\processed` | `paths.processed` |
| Ошибочные импорты | `data\failed` | `paths.failed` |
| Реестр и состояние | `data\state` | `paths.state` |
| Кэш видео | `data\cache` | `paths.cache` |
| Журналы | `data\logs` | `paths.logs` |
| Корень медиатеки | `library` | `paths.library` |
| Фильмы | `library\movies` | `library.moviesFolder` |
| Сериалы | `library\tv` | `library.showsFolder` |

Пути могут быть абсолютными, относительными, находиться на разных дисках, содержать пробелы и кириллицу. Относительные пути считаются от каталога `config.json`. Конкретные пути действующей установки хранятся только в игнорируемом Git файле `config.json`.

Пример для медиатеки на `D:` и кэша на `F:`:

```json
{
  "paths": {
    "library": "D:\\MediaServer\\media",
    "cache": "F:\\TorrServerCache"
  },
  "torrServer": {
    "cacheSizeBytes": 21474836480,
    "cacheCleanupIntervalMs": 300000,
    "cacheInactiveGraceMs": 60000,
    "connectionsLimit": 100,
    "readerReadAheadPercent": 100,
    "metadataWarmupBytes": 4194304,
    "metadataWarmupRecentTorrents": 0,
    "metadataWarmupTimeoutMs": 120000,
    "torrentDisconnectTimeoutSeconds": 600,
    "uploadRateLimit": null,
    "downloadRateLimit": null,
    "disableUpload": null
  },
  "gateway": {
    "stallWarningMs": 15000
  },
  "library": {
    "moviesFolder": "movies",
    "showsFolder": "tv",
    "titlePreference": "metadata"
  }
}
```

Не копируйте только этот фрагмент вместо полного файла: начните с `config.example.json` или разрешите установщику создать конфигурацию.

### Перенос медиатеки

1. Измените `paths.library` и при необходимости имена `moviesFolder`/`showsFolder` в `config.json`, либо повторно запустите `install.ps1 -LibraryPath ...`.
2. Перезапустите процесс: `.\restart.ps1`.
3. Выполните `node .\torrent-jellyfin.mjs rebuild`.
4. Добавьте новые каталоги `movies` и `tv` в Jellyfin и запустите сканирование.
5. Проверьте новые `.strm`.
6. Старое управляемое дерево `.strm` удалите вручную только после проверки. Утилита не удаляет его автоматически.

### Кэш

Кэш расположен в `paths.cache`. Он не является постоянной медиатекой и может быть вытеснен. По умолчанию общий целевой размер — 20 ГиБ (`21474836480` байт). Проверка выполняется каждые 5 минут; неактивному каталогу даётся 60 секунд защиты перед возможным удалением. Во время активного HTTP-потока сканирование и удаление полностью пропускаются. Очистка идёт целыми каталогами infohash от самого давно использованного к новому. Каталоги активных торрентов никогда не удаляются.

`connectionsLimit: 100` и `readerReadAheadPercent: 100` дают TorrServer больше источников и окно загрузки вперёд для тяжёлых 4K-потоков. `torrentDisconnectTimeoutSeconds: 600` сохраняет найденных пиров в течение 10 минут после закрытия последнего запроса, поэтому повторный запуск, перемотка и переход к следующему эпизоду не начинают поиск пиров с нуля. Эти параметры уменьшают вероятность пауз, но не могут компенсировать раздачу, которая реально отдаёт медленнее битрейта видео.

Фоновый прогрев метаданных читает по `metadataWarmupBytes` байт с начала и конца каждого видео только при отсутствии пользовательского потока. Новые импорты ставятся в очередь автоматически. `metadataWarmupRecentTorrents` задаёт число последних торрентов, которые нужно поставить в очередь после запуска; публичное значение по умолчанию — `0`, чтобы установка не создавала неожиданный фоновый трафик. Если начинается просмотр, текущий прогрев отменяется и возобновляется позже. Для слабых раздач это сокращает ожидание анализа MKV, но не загружает само видео целиком.

`uploadRateLimit` и `downloadRateLimit` задаются в KiB/s: `null` сохраняет текущее значение TorrServer, `0` снимает ограничение, положительное целое задаёт лимит. `disableUpload: null` также ничего не меняет. Не включайте `disableUpload: true` без понимания последствий: закрытые трекеры могут требовать раздачу и применять санкции за низкий рейтинг. `watch.peerCheckMs` задаёт длительность фоновой проверки подключённых пиров после импорта; наличие только `totalPeers` не считается установленным соединением.

Чтобы очистить кэш:

1. остановите задачу или процесс;
2. убедитесь, что выбран именно каталог `paths.cache`;
3. удалите только его содержимое;
4. снова запустите задачу или `.\restart.ps1`.

Не удаляйте `data\state` и `data\processed`, если хотите сохранить импорт и возможность восстановления.

### Резервное копирование и перенос установки

Сохраняйте отдельно от Git:

- `config.json`;
- `data\processed`;
- `data\state`.

`data\cache` и `data\logs` резервировать не требуется. После переноса восстановите эти три элемента, запустите `install.ps1`, затем `rebuild`.

## Сеть, Firewall и VPN

- TorrServer API должен оставаться на `127.0.0.1:8090`.
- Шлюз слушает физический LAN-адрес на `8091`.
- Не делайте port forwarding 8090/8091 на роутере и не публикуйте их в интернет.
- Токен в URL — секрет. Не публикуйте `.strm`, `config.json` или журналы с полным URL. Jellyfin и запущенный им FFmpeg могут записать URL вместе с токеном в свои журналы; ограничьте доступ к ним и меняйте токен при утечке.
- Закрепите IPv4 компьютера в DHCP роутера. При смене адреса выполните `install.ps1 -LanAddress <новый-IP>`, затем `rebuild`.

`torrServer.peerBindAddress` привязывает BitTorrent-сокеты к физическому адресу, но сам по себе не гарантирует split tunneling. Если VPN работает в режиме force tunnel, добавьте полный путь к `TorrServer.exe` в Direct/Bypass/Excluded apps вашего VPN-клиента. Для Happ и аналогичных клиентов это настраивается вручную в их интерфейсе. Проект принципиально не изменяет конфигурацию стороннего VPN.

После настройки проверьте маршрут и внешний адрес TorrServer согласно инструкции вашего VPN. Не полагайтесь только на то, что Jellyfin открывается по LAN: локальный поток и исходящий BitTorrent-трафик используют разные соединения.

Для стабильного Direct Play разместите `paths.cache` на локальном SSD, а не на сетевом диске или синхронизируемой папке. При частых паузах исключите каталог кэша и `TorrServer.exe` из проверки Defender только если это допустимо вашей моделью безопасности:

```powershell
Add-MpPreference -ExclusionPath "F:\TorrServerCache"
Add-MpPreference -ExclusionProcess "C:\Path\To\TorrServer.exe"
```

Проверьте, что gateway доступен в LAN, а TorrServer слушает BitTorrent-порт:

```powershell
Test-NetConnection 127.0.0.1 -Port 8091
Get-NetTCPConnection -LocalPort 32000 -State Listen -ErrorAction SilentlyContinue
Get-NetUDPEndpoint -LocalPort 32000 -ErrorAction SilentlyContinue
```

## Диагностика

Начинайте с:

```powershell
node .\torrent-jellyfin.mjs doctor
Get-Content .\data\logs\torrent-jellyfin.log -Tail 100
```

`doctor` проверяет Node.js, каталоги и права записи, конфигурацию TorrServer, LAN-адрес, кэш и созданные `.strm`. Для TorrServer дополнительно сверяются фактические `CacheSize`, `UseDisk`, путь к кэшу, `ConnectionsLimit`, `ReaderReadAHead`, `PreloadCache` и `TorrentDisconnectTimeout`; это позволяет отличить применённые настройки от значений только в `config.json`.

Во время воспроизведения шлюз пишет события `Torrent stream response`, `Torrent stream stalled`, `Torrent stream resumed` и `Torrent stream finished`. В событии ответа фиксируются фактический downstream-статус и статус TorrServer; в событии зависания есть скорость загрузки, количество активных пиров/сидов, Range и время без данных. Обычные клиентские `ECONNRESET`/`EPIPE` молча закрываются, а настоящие ошибки HTTP-протокола остаются в журнале.

### Торрент исчез из inbox

- найден в `data\processed` — импорт успешен;
- найден в `data\failed` — откройте журнал и найдите сообщение с именем файла;
- проверьте `data\state\imports.json` и созданные `.strm`;
- отсутствие видео подходящего расширения считается ошибкой импорта.

### Jellyfin не видит папки

Проверьте `paths.library`, `library.moviesFolder` и `library.showsFolder`. Затем выполните `rebuild` и повторное сканирование библиотек Jellyfin. Каталог `library` внутри проекта используется только если он указан в конфигурации.

### Видео не запускается

1. Откройте `.strm` как текст и скопируйте URL, не публикуя его.
2. Проверьте заголовки и Range локально:

```powershell
curl.exe -I "URL_ИЗ_STRM"
curl.exe -H "Range: bytes=0-1048575" -D - -o NUL "URL_ИЗ_STRM"
```

Первый запрос должен вернуть обычный `200 OK` с полным `Content-Length`; второй — `206 Partial Content` и `Content-Range`. `404` обычно означает неверный токен, hash или индекс; `503` — TorrServer недоступен. Таймаут без первых байтов чаще означает отсутствие сидов или недоступные части.

3. Проверьте `http://127.0.0.1:8090` на самом сервере и запустите `doctor`.
4. Убедитесь, что `.strm` содержит текущий LAN-IP и что TCP 8091 разрешён для `LocalSubnet`.
5. Для большого 4K-файла первый запуск может занять заметно больше времени: TorrServer должен получить метаданные и начальные куски. Проверьте торрент с хорошими сидами.

Если пропала задача автозапуска, откройте PowerShell от имени администратора и выполните:

```powershell
.\install.ps1 -RegisterTask
.\restart.ps1
```

## Удаление

Из PowerShell от имени администратора:

```powershell
.\uninstall.ps1
```

По умолчанию скрипт останавливает управляемые процессы, удаляет задачу автозапуска и точное правило Firewall, но сохраняет `config.json`, архив, состояние, кэш, TorrServer и файлы проекта.

Безвозвратно удалить каталоги inbox/processed/failed/state/cache/logs можно только явным параметром:

```powershell
.\uninstall.ps1 -PurgeData
```

Медиатека `paths.library` никогда не удаляется uninstall-скриптом. Перед `-PurgeData` сделайте резервную копию `data\processed` и `data\state`.

## Разработка, Git и релиз

```powershell
npm test
npm run check
npm run smoke
.\build-release.ps1 -Version v1.2.0
```

`npm run smoke` использует только отдельный временный state/cache и созданный им процесс TorrServer; локальный `config.json` не читается. Если `bin\TorrServer.exe` отсутствует (как в CI), проверка печатает `SKIP` и завершается успешно.

ZIP собирается только по разрешённому списку. В него не попадают `config.json`, `data`, `bin`, `.torrent`, `.strm`, базы, журналы или `.exe`.

Перед первым публичным коммитом:

```powershell
git init -b main
git config user.name "ВАШЕ_ИМЯ_ИЛИ_GITHUB_LOGIN"
git config user.email "ВАШ_EMAIL"

git check-ignore -v config.json
git check-ignore -v bin\TorrServer.exe
git check-ignore -v data\cache
git check-ignore -v data\processed
```

Добавляйте публичные файлы явным списком, а не `git add .`, затем обязательно проверьте staged diff:

```powershell
git add .gitignore .gitattributes
git add LICENSE THIRD_PARTY_NOTICES.md SECURITY.md README.md README.en.md
git add package.json config.example.json
git add torrent-jellyfin.mjs install.ps1 restart.ps1 doctor-elevated.ps1 uninstall.ps1 build-release.ps1 tools\smoke.mjs
git add test .github

git status --short
git diff --cached --stat
git diff --cached
git commit -m "Initial public release"
```

В staged-файлах не должно быть `config.json`, `data`, `bin`, `.torrent`, `.strm`, `.db`, `.log`, `.exe` или реального токена шлюза.

Публикация с GitHub CLI:

```powershell
gh auth login
gh repo create jellyfin-torrent-streamer --public --source . --remote origin --push
git tag -a v1.2.0 -m "jellyfin-torrent-streamer v1.2.0"
git push origin v1.2.0
```

Тег `v*` запускает GitHub Actions: тесты на Windows с Node.js 20/22/24, синтаксическую проверку PowerShell, сборку безопасного ZIP и создание GitHub Release.

## Лицензии

Собственный код — [MIT](LICENSE). TorrServer — отдельный компонент под GPL-3.0, который загружается с официального релиза; подробности находятся в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
