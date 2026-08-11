# Генерация bcrypt хеша пароля

`wgpw` — утилита для генерации bcrypt хешей паролей для использования с RedNetAmnezia.

## Особенности

- Генерация bcrypt хеша пароля (стоимость 12 раундов)
- Простая интеграция с `.env` для настройки пароля администратора

---

## Способ 1: Локально с Node.js (рекомендуется)

Если у вас установлен Node.js, выполните команду из директории `src/`:

```sh
node src/wgpw.mjs YOUR_PASSWORD
```

Пример вывода:
```
ORIGINAL_PASSWORD='YOUR_PASSWORD'

# Используйте это в .env
PASSWORD_HASH=$2b$12$coPqCsPtcFO.Ab99xylBNOW4.Iu7OOA2/ZIboHN6/oyxca3MWo7fW
```

Если пароль не указан, утилита запросит его интерактивно:

```sh
node src/wgpw.mjs
Введите пароль:      // скрытый ввод, наберите пароль
ORIGINAL_PASSWORD='YOUR_PASSWORD'

# Используйте это в .env
PASSWORD_HASH=$2b$12$coPqCsPtcFO.Ab99xylBNOW4.Iu7OOA2/ZIboHN6/oyxca3MWo7fW
```

---

## Способ 2: Через Docker

Если Node.js не установлен локально, можно запустить утилиту внутри контейнера:

```sh
docker run --rm -it rednetamnezia:latest node wgpw.mjs YOUR_PASSWORD
```

Или интерактивно (без пароля в истории команд):

```sh
docker run --rm -it rednetamnezia:latest node wgpw.mjs
Введите пароль:      // скрытый ввод, наберите пароль
```

---

## Использование сгенерированного хеша

### В `.env` файле (рекомендуется)

Скопируйте значение `PASSWORD_HASH` из вывода утилиты в ваш `.env`:

```env
PASSWORD_HASH='$2b$12$coPqCsPtcFO.Ab99xylBNOW4.Iu7OOA2/ZIboHN6/oyxca3MWo7fW'
```

> **Важно:** Всегда заключайте значение в **одинарные кавычки** в `.env` файле. Символ `$` имеет специальное значение в bash, и без кавычек хеш будет повреждён.

### Напрямую в `docker-compose.yml`

Если вы записываете хеш напрямую в `docker-compose.yml`, необходимо **экранировать** каждый символ `$`, добавив перед ним ещё один `$`:

```yaml
environment:
  - PASSWORD_HASH=$$2b$$12$$coPqCsPtcFO.Ab99xylBNOW4.Iu7OOA2/ZIboHN6/oyxca3MWo7fW
```

Это связано с тем, что Docker Compose интерпретирует `$` как начало переменной. Экранирование `$$` говорит Compose передать буквальный `$`.

---

## Почему важны одинарные кавычки

Сравните поведение bash:

```bash
$ echo $2b$12$coPqCsPtcF    # ← неправильно (bash интерпретирует $2, $12, $co...)
b2
$ echo "$2b$12$coPqCsPtcF"   # ← неправильно (двойные кавычки не защищают $)
b2
$ echo '$2b$12$coPqCsPtcF'   # ← правильно (одинарные кавычки)
$2b$12$coPqCsPtcF
```

**Вывод:** всегда используйте **одинарные кавычки** для `PASSWORD_HASH` в `.env`.

---

## Пример для проверки

Хеш ниже соответствует паролю `foobar123`:

```env
PASSWORD_HASH='$2y$10$hBCoykrB95WSzuV4fafBzOHWKu9sbyVa34GJr8VV5R/pIelfEMYyG'
```

Можете использовать его для проверки работы аутентификации (после теста обязательно смените на свой).
