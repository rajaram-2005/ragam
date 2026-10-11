import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { Shell } from './components/Shell.jsx'
import { AREAS } from './areas.js'
import { Chip, Button } from './components/ui.jsx'
import ChatArea from './areas/ChatArea.jsx'
import ImageArea from './areas/ImageArea.jsx'
import VideoArea from './areas/VideoArea.jsx'
import PluginsArea from './areas/PluginsArea.jsx'
import McpArea from './areas/McpArea.jsx'

const AREA_COPY = {
  chat: {
    title: 'Chat',
    subtitle: 'Local-first conversation with retrieval grounding, credential redaction and the God Core task lifecycle.',
  },
  image: {
    title: 'Image',
    subtitle: 'Image generation through real adapters, with output validation before anything is shown as a result.',
  },
  video: {
    title: 'Video',
    subtitle: 'Video generation with provenance checks — a still image is never presented as generated video.',
  },
  plugins: {
    title: 'Plugins',
    subtitle: 'Permissioned plugins: validated manifests, capability checks, preflight and an audit trail.',
  },
  mcp: {
    title: 'MCP',
    subtitle: 'Model Context Protocol servers and tools, with schema validation, approval gates and untrusted output handling.',
  },
}

const HASH_AREAS = new Set(AREAS.map((area) => area.id))

function areaFromLocation() {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return HASH_AREAS.has(hash) ? hash : 'chat'
}

export default function App() {
  const [active, setActive] = useState(areaFromLocation)
  const [readiness, setReadiness] = useState(null)
  const [config, setConfig] = useState(null)
  const [readinessError, setReadinessError] = useState(null)
  const [probing, setProbing] = useState(false)

  const select = useCallback((id) => {
    setActive(id)
    if (window.location.hash !== `#/${id}`) window.location.hash = `#/${id}`
  }, [])

  const refresh = useCallback(async ({ probe = false } = {}) => {
    setProbing(true)
    try {
      if (probe) await api.probeModels().catch(() => null)
      const [ready, publicConfig] = await Promise.all([api.ready(), api.config()])
      setReadiness(ready)
      setConfig(publicConfig)
      setReadinessError(null)
    } catch (error) {
      setReadinessError(error)
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onHashChange = () => setActive(areaFromLocation())
    window.addEventListener('hashchange', onHashChange)
    // Readiness changes when a model appears or a provider goes away; poll slowly
    // rather than pretending the status is live.
    const timer = setInterval(() => refresh(), 20000)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      clearInterval(timer)
    }
  }, [refresh])

  const shared = useMemo(
    () => ({ readiness, config, refreshReadiness: () => refresh({ probe: true }) }),
    [readiness, config, refresh],
  )

  const area = AREAS.find((candidate) => candidate.id === active) ?? AREAS[0]
  const copy = AREA_COPY[area.id]

  return (
    <Shell
      active={area.id}
      onSelect={select}
      readiness={readiness}
      config={config}
      readinessError={readinessError}
      onRefresh={() => refresh({ probe: true })}
      title={copy.title}
      subtitle={copy.subtitle}
      topActions={
        <>
          <Chip tone={readiness ? (readiness.status === 'ready' ? 'ok' : readiness.status === 'degraded' ? 'warn' : 'bad') : undefined}>
            {readiness?.status ?? 'unknown'}
          </Chip>
          {config?.policy ? <Chip tone={config.offlineEnforced ? 'bad' : 'info'}>{config.policy.replace(/_/g, ' ')}</Chip> : null}
          <Button busy={probing} onClick={() => refresh({ probe: true })}>
            Re-probe models
          </Button>
        </>
      }
    >
      {area.id === 'chat' ? <ChatArea {...shared} /> : null}
      {area.id === 'image' ? <ImageArea {...shared} /> : null}
      {area.id === 'video' ? <VideoArea {...shared} /> : null}
      {area.id === 'plugins' ? <PluginsArea {...shared} /> : null}
      {area.id === 'mcp' ? <McpArea {...shared} /> : null}
    </Shell>
  )
}
