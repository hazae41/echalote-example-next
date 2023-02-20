import { CircuitPool, CircuitPoolParams, createWebSocketSnowflakeStream, Tor } from "@hazae41/echalote";
import { FetcherMore, getSingleSchema, useQuery } from "@hazae41/xswr";
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

async function createTor() {
  const tcp = await createWebSocketSnowflakeStream("wss://snowflake.bamsoftware.com/")
  // const tcp =  await createMeekStream("https://meek.bamsoftware.com/")
  // const tcp =  await createWebSocketStream("ws://localhost:8080")

  return new Tor(tcp, { fallbacks })
}

function useTor() {
  return useAsyncMemo(() => createTor(), [])
}

function createCircuitPool(tor: Tor | undefined, params: CircuitPoolParams) {
  if (!tor) return

  return new CircuitPool(tor, params)
}

function useCircuitPool(tor: Tor | undefined, params: CircuitPoolParams) {
  return useMemo(() => createCircuitPool(tor, params), [tor])
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
  return getSingleSchema(url, fetchText)
}

function useText(url: string) {
  return useQuery(getText, [url])
}

async function tryFetchTorText(url: string, pool: CircuitPool, params: FetcherMore) {
  const { signal } = params

  while (true) {
    if (signal?.aborted)
      throw new Error(`Aborted`)
    const circuit = await pool.get()

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

function getTorText(url: string, pool?: CircuitPool) {
  const key = pool ? `tor:${url}` : undefined
  const fetcher = pool ? (_: string, more: FetcherMore) => tryFetchTorText(url, pool!, more) : undefined
  return getSingleSchema(key, fetcher, { timeout: 30 * 1000 })
}

function useTorText(url: string, pool?: CircuitPool) {
  return useQuery(getTorText, [url, pool])
}

function errorToString(error: unknown) {
  if (error instanceof Error)
    return error.message
  return JSON.stringify(error)
}

export default function Page() {
  const tor = useTor()
  const pool = useCircuitPool(tor, { count: 5 })

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