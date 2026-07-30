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

TorrServer загружает необходимые куски файла и хранит их в циклическом дисковом кэше. Значение `cacheSizeBytes` — целевой размер, а не жёсткая файловая квота: во время активных потоков и отложенного вытеснения кэш может временно стать больше.

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
git clone https://github.com/OWNER/jellyfin-torrent-streamer.git
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

Имена `S01E02`, `S01.E02` и `1x02` распознаются как эпизоды и раскладываются в `tv\Название\Season 01`. Одиночные и неэпизодические видео попадают в `movies\Название торрента`. Нераспознанные дополнительные видео сериала попадают в `Extras`. Существующие пользовательские файлы не перезаписываются; при конфликте к имени добавляется короткий infohash.

## Импорт и команды

Положите `.torrent` в `data\inbox` или импортируйте его напрямую:

```powershell
node .\torrent-jellyfin.mjs import "D:\Downloads\example.torrent"
```

Основные команды:

```powershell
node .\torrent-jellyfin.mjs run
node .\torrent-jellyfin.mjs doctor
node .\torrent-jellyfin.mjs rebuild
node .\torrent-jellyfin.mjs import "file.torrent"
```

Если конфигурация находится не рядом со скриптом, добавьте `--config`:

```powershell
node .\torrent-jellyfin.mjs doctor --config "D:\Config\torrent-streamer.json"
```

`rebuild` заново создаёт управляемые ссылки по реестру и архиву, но намеренно не удаляет старую медиатеку. Это защищает пользовательские файлы.

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

Пути могут быть абсолютными, относительными, находиться на разных дисках, содержать пробелы и кириллицу. Относительные пути считаются от каталога `config.json`.

Для исходной локальной установки в `F:\media_server_project` относительные пути разворачиваются в `F:\media_server_project\data\inbox`, `processed`, `failed`, `state`, `cache` и `logs`, а медиатека из локального `config.json` находится в `D:\MediaServer\media\movies` и `D:\MediaServer\media\tv`. Эти значения — пример конкретной установки, а не зашитые публичные настройки. На момент подготовки релиза кэш занимал около 22,14 ГиБ при цели 20 ГиБ; временный перерасход допустим из-за активных частей и отложенного вытеснения.

Пример для медиатеки на `D:` и кэша на `F:`:

```json
{
  "paths": {
    "library": "D:\\MediaServer\\media",
    "cache": "F:\\media_server_project\\data\\cache"
  },
  "torrServer": {
    "cacheSizeBytes": 21474836480
  },
  "library": {
    "moviesFolder": "movies",
    "showsFolder": "tv"
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

Кэш расположен в `paths.cache`. Он не является постоянной медиатекой и может быть вытеснен. По умолчанию целевой размер — 20 ГиБ (`21474836480` байт), предварительная загрузка — 1%.

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
- Токен в URL — секрет. Не публикуйте `.strm`, `config.json` или журналы с полным URL.
- Закрепите IPv4 компьютера в DHCP роутера. При смене адреса выполните `install.ps1 -LanAddress <новый-IP>`, затем `rebuild`.

`torrServer.peerBindAddress` привязывает BitTorrent-сокеты к физическому адресу, но сам по себе не гарантирует split tunneling. Если VPN работает в режиме force tunnel, добавьте полный путь к `TorrServer.exe` в Direct/Bypass/Excluded apps вашего VPN-клиента. Для Happ и аналогичных клиентов это настраивается вручную в их интерфейсе. Проект принципиально не изменяет конфигурацию стороннего VPN.

После настройки проверьте маршрут и внешний адрес TorrServer согласно инструкции вашего VPN. Не полагайтесь только на то, что Jellyfin открывается по LAN: локальный поток и исходящий BitTorrent-трафик используют разные соединения.

## Диагностика

Начинайте с:

```powershell
node .\torrent-jellyfin.mjs doctor
Get-Content .\data\logs\torrent-jellyfin.log -Tail 100
```

`doctor` проверяет Node.js, каталоги и права записи, конфигурацию TorrServer, LAN-адрес, кэш и созданные `.strm`.

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

Второй запрос должен вернуть `206 Partial Content` и `Content-Range`. `404` обычно означает неверный токен, hash или индекс; `503` — TorrServer недоступен. Таймаут без первых байтов чаще означает отсутствие сидов или недоступные части.

3. Проверьте `http://127.0.0.1:8090` на самом сервере и запустите `doctor`.
4. Убедитесь, что `.strm` содержит текущий LAN-IP и что TCP 8091 разрешён для `LocalSubnet`.
5. Для большого 4K-файла первый запуск может занять заметно больше времени: TorrServer должен получить метаданные и начальные куски. Проверьте торрент с хорошими сидами.

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
.\build-release.ps1 -Version v1.0.0
```

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
git add torrent-jellyfin.mjs install.ps1 restart.ps1 doctor-elevated.ps1 uninstall.ps1 build-release.ps1
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
git tag -a v1.0.0 -m "jellyfin-torrent-streamer v1.0.0"
git push origin v1.0.0
```

Тег `v*` запускает GitHub Actions: тесты на Windows с Node.js 20/22/24, синтаксическую проверку PowerShell, сборку безопасного ZIP и создание GitHub Release.

## Лицензии

Собственный код — [MIT](LICENSE). TorrServer — отдельный компонент под GPL-3.0, который загружается с официального релиза; подробности находятся в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
