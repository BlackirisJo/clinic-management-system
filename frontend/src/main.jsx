import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { setupPwaListeners } from './lib/pwa.js'

// التقاط حدث التثبيت مبكراً قبل أن يصل React (الحدث يُطلق مرة واحدة فقط)
setupPwaListeners()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
