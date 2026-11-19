import CssBaseline from '@mui/material/CssBaseline'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { createRoot } from 'react-dom/client'
import { makeRows } from './data'
import { mark, spike } from './instrument'
import { computeTotals, createServerStub, type Totals } from './server/stub'
import { PriceTable } from './table/PriceTable'
import { RowStore } from './table/store'

// The colours of the cabinet's light scheme (packages/ui/src/theme/tokens.ts), without its fonts.
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#A63D12', contrastText: '#FFFFFF' },
    error: { main: '#9C3D26' },
    background: { default: '#FFF8EC', paper: '#FFFCF5' },
    text: { primary: '#241710', secondary: '#695547' },
    divider: '#E1CDB6',
  },
  shape: { borderRadius: 10 },
  typography: { fontFamily: '"Golos Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif', button: { textTransform: 'none' } },
})

const params = new URLSearchParams(location.search)
const count = Math.max(0, Math.min(100_000, Number(params.get('rows') ?? 300)))
const seed = Number(params.get('seed') ?? 1)
const mode = (params.get('mode') ?? 'auto') as 'auto' | 'grid' | 'cards'
const checkbox = (params.get('cb') ?? 'mui') as 'mui' | 'plain'

mark('data:start')
const rows = makeRows(count, seed)
const store = new RowStore(rows)
mark('data:end')

const totalsListeners = new Set<(t: Totals) => void>()
const server = createServerStub(
  () => store.rows.values(),
  (t) => {
    spike.totals = t
    totalsListeners.forEach((l) => l(t))
  },
)
store.send = (batch) => server.accept(batch)
const subscribeTotals = (listener: (t: Totals) => void) => {
  totalsListeners.add(listener)
  if (spike.totals) listener(spike.totals as Totals)
  return () => totalsListeners.delete(listener)
}

Object.assign(spike, {
  store,
  server,
  computeTotals: () => computeTotals(store.rows.values()),
  /** Someone else edits: `count` random rows among those on screen get a new price. */
  remoteEdit(count = 1) {
    const view = (spike.view as string[]) ?? []
    const scroller = (document.querySelector('[data-grid]') ?? document.querySelector('[data-cards]')) as HTMLElement | null
    const rendered = [...(scroller?.querySelectorAll('[data-row]') ?? [])].map((el) => (el as HTMLElement).dataset.row as string)
    const pool = rendered.length > 0 ? rendered : view
    const changes = []
    for (let i = 0; i < count; i++) {
      const id = pool[Math.floor(Math.random() * pool.length)]
      if (!id) continue
      const rubles = 100 + Math.floor(Math.random() * 5000)
      changes.push({ id, cells: { price: `${rubles}.00` } })
    }
    store.applyRemote(changes)
  },
})

document.documentElement.style.height = '100%'
document.body.style.height = '100%'
const el = document.getElementById('root') as HTMLElement
el.style.height = '100dvh'

mark('render:start')
createRoot(el).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <PriceTable store={store} title="Прайс-лист: зима 2026" mode={mode} checkbox={checkbox} subscribeTotals={subscribeTotals} />
  </ThemeProvider>,
)
