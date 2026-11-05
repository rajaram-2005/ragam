import React from 'react'
import { Panel } from './ui.jsx'

/** Legacy export kept for older integrations; the active product has no model-training panel. */
export default function UserTrainingPanel() {
  return <Panel title="Model training is not part of Klyvaron tiers">
    <p className="small">
      Lite, Pro and Max are resource profiles of one shared, model-independent processing engine.
      They do not require separate models, weight downloads or training jobs.
    </p>
    <p className="small">
      User-authorized information can be added to account-local knowledge or persistent memory
      through the explicit save and remember controls. It is not used to train model weights.
    </p>
  </Panel>
}
