import React from 'react'
import { Banner, Button, Panel } from '../components/ui.jsx'
export default function VideoArea({ onSettings }) {
  return <Panel title="Online video generation"><Banner tone="warn" title="Video adapter not connected"><p>This area is retained, but this increment does not implement a qualified online video adapter. A model name in the gateway catalog does not prove this capability.</p><p>No simulated output or local fallback will be used.</p></Banner><Button onClick={onSettings}>Provider Settings</Button></Panel>
}
