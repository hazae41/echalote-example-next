import { Berith } from "@hazae41/berith";
import { Circuit, createCircuitPool, createWebSocketSnowflakeStream, Fallback, TorClientDuplex } from "@hazae41/echalote";
import { Ed25519 } from "@hazae41/ed25519";
import { Morax } from "@hazae41/morax";
import { Mutex } from "@hazae41/mutex";
import { Pool, PoolParams } from "@hazae41/piscine";
import { Sha1 } from "@hazae41/sha1";
import { X25519 } from "@hazae41/x25519";
import { DataInit, FailInit, Fetched, getSchema, useSchema } from "@hazae41/xswr";
import { DependencyList, useCallback, useEffect, useMemo, useState } from "react";

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
    await Berith.initBundledOnce()
    await Morax.initBundledOnce()

    const ed25519 = Ed25519.fromBerith(Berith)
    const x25519 = X25519.fromBerith(Berith)
    const sha1 = Sha1.fromMorax(Morax)

    const fallbacksUrl = "https://raw.githubusercontent.com/hazae41/echalote/master/tools/fallbacks/fallbacks.json"
    const fallbacksRes = await fetchAsJson<Fallback[]>(fallbacksUrl)
    const fallbacks = Fetched.from(fallbacksRes).unwrap()

    const tcp = await createWebSocketSnowflakeStream("wss://snowflake.bamsoftware.com/")
    // const tcp =  await createMeekStream("https://meek.bamsoftware.com/")
    // const tcp =  await createWebSocketStream("ws://localhost:8080")

    return new TorClientDuplex(tcp, { fallbacks, ed25519, x25519, sha1 })
  }, [])
}

function useCircuitPool(tor?: TorClientDuplex, params?: PoolParams) {
  return useMemo(() => {
    if (!tor) return

    return createCircuitPool(tor, params)
  }, [tor])
}

function useMutex<T>(inner?: T) {
  return useMemo(() => {
    if (!inner) return

    return new Mutex(inner)
  }, [inner])
}

async function fetchAsJson<T>(url: string) {
  const res = await fetch(url)

  if (!res.ok) {
    const error = new Error(await res.text())
    return { error } as FailInit
  }

  const data = await res.json()
  return { data } as DataInit<T>
}

async function fetchAsText(url: string) {
  const res = await fetch(url)

  if (!res.ok) {
    const error = new Error(await res.text())
    return { error }
  }

  const data = await res.text()
  return { data }
}

function getText(url: string) {
  return getSchema(url, fetchAsText)
}

function useText(url: string) {
  return useSchema(getText, [url])
}

async function tryFetchTorAsText(url: string, pool: Mutex<Pool<Circuit>>, init: RequestInit) {
  const { signal } = init

  while (true) {
    if (signal?.aborted)
      throw new Error(`Aborted`)

    const circuit = await pool.lock(async (circuits) => {
      const circuit = await circuits.cryptoRandom()
      circuits.delete(circuit)
      return circuit
    })

    try {
      const signal = AbortSignal.timeout(5000)
      const res = (await circuit.tryFetch(url, { signal })).unwrap()

      if (!res.ok) {
        const error = new Error(await res.text())
        return { error }
      }

      const data = await res.text()
      return { data }
    } catch (e: unknown) {
      if (signal?.aborted) throw e

      circuit.tryDestroy()

      console.warn("Fetch failed", e)
      await new Promise(ok => setTimeout(ok, 1000))
    }
  }
}

function getTorText(url: string, pool?: Mutex<Pool<Circuit>>) {
  if (!pool) return

  return getSchema(`tor:${url}`, async (_, init) => {
    return tryFetchTorAsText(url, pool, init)
  }, { timeout: 30 * 1000 })
}

function useTorText(url: string, pool?: Mutex<Pool<Circuit>>) {
  return useSchema(getTorText, [url, pool])
}

export namespace Errors {

  export function toString(error: unknown) {
    if (error instanceof Error)
      return error.message
    return JSON.stringify(error)
  }

}

export default function Page() {
  const tor = useTor()
  const pool = useCircuitPool(tor, { capacity: 10 })
  const mutex = useMutex(pool)

  const realIP = useText("https://icanhazip.com")
  const torIP = useTorText("https://icanhazip.com", mutex)

  const onClick = useCallback(() => {
    realIP.fetch()
    torIP.fetch()
  }, [realIP, torIP])

  const [_, setCounter] = useState(0)

  useEffect(() => {
    if (!pool) return

    const onCreatedOrDeleted = () => {
      setCounter(c => c + 1)
    }

    pool.events.addEventListener("created", onCreatedOrDeleted, { passive: true })
    pool.events.addEventListener("deleted", onCreatedOrDeleted, { passive: true })

    return () => {
      pool.events.removeEventListener("created", onCreatedOrDeleted)
      pool.events.removeEventListener("deleted", onCreatedOrDeleted)
    }
  }, [pool])

  return <>
    Open browser console and <button onClick={onClick}>click me</button>
    <div>
      {`Your real IP address is: `}
      {(() => {
        if (realIP.loading)
          return <>Loading...</>
        if (realIP.error)
          return <>Error: {Errors.toString(realIP.error)}</>
        return <>{realIP.data}</>
      })()}
    </div>
    <div>
      {`Your Tor IP address is: `}
      {(() => {
        if (torIP.loading)
          return <>Loading...</>
        if (torIP.error)
          return <>Error: {Errors.toString(torIP.error)}</>
        return <>{torIP.data}</>
      })()}
    </div>
    {pool &&
      <div>
        Circuits pool size: {pool.size} / {pool.capacity}
      </div>}
  </>
}