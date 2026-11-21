// A synthetic price list of a bakery and café: every name, price and note is made up here.
// The same seed gives the same rows, so the checks and the measurements see the same table.
import type { PriceRow } from './table/model'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Base = { names: string[]; units: string[]; min: number; max: number }

const BASES: Record<string, Base> = {
  Хлеб: {
    names: ['Бородинский', 'Багет', 'Чиабатта', 'Хлеб на закваске', 'Ржаной с тмином', 'Батон нарезной', 'Хлеб зерновой', 'Фокачча с розмарином', 'Лаваш', 'Хлеб с отрубями', 'Белый формовой', 'Дарницкий'],
    units: ['шт', 'шт', '500 г', '700 г'],
    min: 60,
    max: 380,
  },
  Пироги: {
    names: ['Пирог с вишней', 'Пирог с капустой', 'Пирог с брусникой', 'Курник', 'Расстегай с рыбой', 'Пирог с яблоком', 'Пирог с мясом', 'Пирог с картофелем и грибами', 'Пирог с облепихой', 'Кулебяка'],
    units: ['шт', '900 г', '1 кг', '1,2 кг'],
    min: 420,
    max: 2600,
  },
  Торты: {
    names: ['Медовик', 'Наполеон', 'Шоколадный торт', 'Торт «Ягодный»', 'Прага', 'Красный бархат', 'Морковный торт', 'Птичье молоко', 'Эстерхази', 'Торт «Сметанник»'],
    units: ['кг', 'шт', '1,5 кг', '2 кг'],
    min: 950,
    max: 6900,
  },
  Выпечка: {
    names: ['Круассан', 'Слойка с яблоком', 'Ватрушка', 'Синнабон', 'Плюшка московская', 'Сочник', 'Пончик', 'Улитка с маком', 'Бриошь', 'Кекс с изюмом'],
    units: ['шт', 'шт', 'шт', '100 г'],
    min: 60,
    max: 290,
  },
  Десерты: {
    names: ['Эклер', 'Чизкейк', 'Тирамису', 'Панна-котта', 'Макарон', 'Профитроли', 'Картошка', 'Трубочка со сгущёнкой', 'Шу с ванилью', 'Павлова'],
    units: ['шт', 'порция', 'шт', '100 г'],
    min: 120,
    max: 690,
  },
  Напитки: {
    names: ['Морс клюквенный', 'Квас домашний', 'Капучино', 'Чай облепиховый', 'Лимонад тархун', 'Сбитень', 'Какао', 'Раф ванильный', 'Компот из сухофруктов', 'Американо'],
    units: ['0,3 л', '0,5 л', '1 л', 'шт'],
    min: 90,
    max: 420,
  },
  Сэндвичи: {
    names: ['Сэндвич с ветчиной', 'Сэндвич с курицей', 'Круассан с лососем', 'Бейгл с творожным сыром', 'Шаверма', 'Сэндвич с тунцом', 'Панини с моцареллой', 'Клаб-сэндвич'],
    units: ['шт', 'шт', 'порция'],
    min: 190,
    max: 620,
  },
  Салаты: {
    names: ['Оливье', 'Цезарь с курицей', 'Винегрет', 'Греческий', 'Сельдь под шубой', 'Салат с печёной свёклой', 'Мимоза', 'Салат с языком'],
    units: ['порция', '200 г', '100 г'],
    min: 190,
    max: 690,
  },
}

const MODIFIERS = ['', '', '', ' мини', ' большой', ' семейный', ' на заказ', ' без сахара', ' постный', ' праздничный', ' к чаю', ' по-домашнему']
const NOTES = [
  '',
  '',
  '',
  '',
  'Хит продаж',
  'Без сахара',
  'Только по выходным',
  'Предзаказ за 2 дня',
  'Можно без орехов',
  'Печём с 7:00, лучше брать до обеда',
  'Состав: мука, масло, яйца, сахар; аллергены — глютен, молоко',
  'Нужна табличка «Новинка» на витрине',
  'Ещё раз уточнить цену у поставщика ягод: в декабре она обычно растёт, а летом падает почти вдвое',
  'Ёлочная серия — до 10 января',
]

function priceIn(rand: () => number, min: number, max: number): string {
  const rubles = Math.round((min + rand() * (max - min)) / 10) * 10
  const kopecks = rand() < 0.15 ? (rand() < 0.5 ? 50 : 90) : 0
  return `${rubles}.${String(kopecks).padStart(2, '0')}`
}

export function rowId(n: number): string {
  return `r${n.toString(36).padStart(4, '0')}`
}

/** `count` rows of a synthetic price list. */
export function makeRows(count: number, seed = 1): PriceRow[] {
  const rand = mulberry32(seed)
  const categories = Object.keys(BASES)
  const used = new Map<string, number>()
  const rows: PriceRow[] = []
  for (let n = 0; n < count; n++) {
    const category = categories[Math.floor(rand() * categories.length)] ?? 'Хлеб'
    const base = BASES[category] as Base
    const name0 = (base.names[Math.floor(rand() * base.names.length)] ?? 'Изделие') + (MODIFIERS[Math.floor(rand() * MODIFIERS.length)] ?? '')
    const seen = used.get(name0) ?? 0
    used.set(name0, seen + 1)
    const name = seen === 0 ? name0 : `${name0}, вариант ${seen + 1}`
    const wedding = category === 'Торты' && rand() < 0.05
    rows.push({
      id: rowId(n + 1),
      name: wedding ? `${name} свадебный` : name,
      category,
      unit: base.units[Math.floor(rand() * base.units.length)] ?? 'шт',
      price: wedding ? priceIn(rand, 9000, 24000) : priceIn(rand, base.min, base.max),
      inStock: rand() < 0.82,
      note: NOTES[Math.floor(rand() * NOTES.length)] ?? '',
    })
  }
  return rows
}
