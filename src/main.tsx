import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useMixer } from './store/useMixer'
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/premium.css'
import './styles/redesign.css'
import './styles/panel.css'
import './styles/theme.css'
import './styles/guide.css'
import './styles/studio.css'
import './styles/console-v2.css'
import './styles/glass.css'

// Re-apply the persisted theme before the first paint. `?theme=studio|light|dark`
// keeps theme previews and screenshots deterministic.
const requestedTheme = new URLSearchParams(window.location.search).get('theme')
if (requestedTheme === 'studio' || requestedTheme === 'light' || requestedTheme === 'dark') {
  // Deterministic preview: update runtime state and the DOM, but do not write
  // the preview theme back into the user's persisted settings.
  document.documentElement.dataset.theme = requestedTheme
  useMixer.setState({ theme: requestedTheme })
} else {
  document.documentElement.dataset.theme = useMixer.getState().theme
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
