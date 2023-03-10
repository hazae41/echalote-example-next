import { Circuit, createCircuitPool, createWebSocketSnowflakeStream, TorClientDuplex } from "@hazae41/echalote";
import { Pool, PoolParams } from "@hazae41/piscine";
import { getSchema, useSchema } from "@hazae41/xswr";
import { DependencyList, useCallback, useEffect, useMemo, useState } from "react";
import fallbacks from "../assets/fallbacks.json";

function useAsyncMemo<T>(factory: () => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<T>()

  useEffect(() => {
    factory().then(setState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

function useTor() {
  return useAsyncMemo(async () => {
    const tcp = await createWebSocketSnowflakeStream("wss://snowflake.bamsoftware.com/")
    // const tcp =  await createMeekStream("https://meek.bamsoftware.com/")
    // const tcp =  await createWebSocketStream("ws://localhost:8080")

    return new TorClientDuplex(tcp, { fallbacks })
  }, [])
}

function useCircuitPool(tor?: TorClientDuplex, params?: PoolParams) {
  return useMemo(() => {
    if (!tor) return

    return createCircuitPool(tor, params)
  }, [tor])
}

async function fetchText(url: string) {
  const res = await fetch(url)

  if (!res.ok) {
    const error = new Error(await res.text())
    return { error }
  }

  const data = await res.text()
  return { data }
}

function getText(url: string) {
  return getSchema(url, fetchText)
}

function useText(url: string) {
  return useSchema(getText, [url])
}

async function tryFetchTorText(url: string, pool: Pool<Circuit>, init: RequestInit) {
  const { signal } = init

  while (true) {
    if (signal?.aborted)
      throw new Error(`Aborted`)

    const circuit = await pool.random()

    try {
      const signal = AbortSignal.timeout(5000)
      const res = await circuit.fetch(url, { signal })

      if (!res.ok) {
        const error = new Error(await res.text())
        return { error }
      }

      const data = await res.text()
      return { data }
    } catch (e: unknown) {
      if (signal?.aborted) throw e

      circuit.destroy()

      console.warn("Fetch failed", e)
      await new Promise(ok => setTimeout(ok, 1000))
    }
  }
}

function getTorText(url: string, pool?: Pool<Circuit>) {
  if (!pool) return

  return getSchema(`tor:${url}`, async (_: string, init: RequestInit) => {
    return tryFetchTorText(url, pool!, init)
  }, { timeout: 30 * 1000 })
}

function useTorText(url: string, pool?: Pool<Circuit>) {
  return useSchema(getTorText, [url, pool])
}

function errorToString(error: unknown) {
  if (error instanceof Error)
    return error.message
  return JSON.stringify(error)
}

export default function Page() {
  const tor = useTor()
  const pool = useCircuitPool(tor, { capacity: 10 })

  const realIP = useText("https://icanhazip.com")
  const torIP = useTorText("https://icanhazip.com", pool)

  const onClick = useCallback(() => {
    realIP.fetch()
    torIP.fetch()
  }, [realIP, torIP])

  return <>
    Open browser console and <button onClick={onClick}>click me</button>
    <div>
      {`Your real IP address is: `}
      {(() => {
        if (realIP.loading)
          return <>Loading...</>
        if (realIP.error)
          return <>Error: {errorToString(realIP.error)}</>
        return <>{realIP.data}</>
      })()}
    </div>
    <div>
      {`Your Tor IP address is: `}
      {(() => {
        if (torIP.loading)
          return <>Loading...</>
        if (torIP.error)
          return <>Error: {errorToString(torIP.error)}</>
        return <>{torIP.data}</>
      })()}
    </div>
  </>
}