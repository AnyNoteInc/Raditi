const { redactSecretValues, isSecretFieldName } = await import('<repo>/packages/domain/src/browser/observation.ts')
const names = ['Код чанка (HTML)', 'Код сниппета (PHP)', 'Код шаблона (HTML)', 'Код плагина (PHP)', 'Код товара', 'Код товара (SKU)', 'Артикул', 'Код купона', 'Код', 'HTML-код', 'Код подтверждения', 'Код страны', 'Индекс', 'Пароль', 'Значение', 'Код страницы', 'Символьный код', 'Внешний код', 'Код валюты', 'Код языка', 'Код статьи', 'Промокод', 'Токен', 'Ключ', 'Ключевые слова', 'Мета-ключи', 'API key', 'Coupon Code', 'Product Code', 'Model', 'Code', 'Access token']
const f = isSecretFieldName ?? ((n) => redactSecretValues(`- textbox "${n}" [ref=e1]: value`).includes('[hidden]'))
console.log(names.map((n) => `${f(n) ? 'СКРЫТО' : 'видно '} ${n}`).join('\n'))
