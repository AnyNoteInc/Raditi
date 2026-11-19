import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import App from './App.jsx'
import './app.css'

const theme = createTheme({ palette: { primary: { main: '#5b4bdb' } }, shape: { borderRadius: 10 } })
createRoot(document.getElementById('root')).render(
  <ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider>,
)
