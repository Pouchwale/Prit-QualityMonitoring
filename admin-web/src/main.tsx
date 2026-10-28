import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startResponsiveTables } from './lib/responsiveTables'
import { startScrollHints } from './lib/scrollHints'

startResponsiveTables()
startScrollHints()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
