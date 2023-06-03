import { Circuit, createPooledCircuit, createPooledTor, createWebSocketSnowflakeStream, Fallback, TooManyRetriesError, TorClientDuplex, tryCreateLoop } from "@hazae41/echalote";
import { Ed25519 } from "@hazae41/ed25519";
import { Mutex } from "@hazae41/mutex";
import { Pool, PoolParams } from "@hazae41/piscine";
import { Ok, Result } from "@hazae41/result";
import { Sha1 } from "@hazae41/sha1";
import { X25519 } from "@hazae41/x25519";
import { Data, Fail, FetcherMore, getSchema, useSchema } from "@hazae41/xswr";
import { ed25519 as noble_ed25519, x25519 as noble_x25519 } from "@noble/curves/ed25519";
import { sha1 as noble_sha1 } from "@noble/hashes/sha1";
import { DependencyList, useCallback, useEffect, useMemo, useState } from "react";

export namespace Errors {

  export function toString(error: unknown) {
    if (error instanceof Error)
      return error.message
    return JSON.stringify(error)
  }

}

function useAsyncMemo<T>(factory: () => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<T>()

  useEffect(() => {
    factory().then(setState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

function useTorPool(params?: PoolParams) {
  return useAsyncMemo(async () => {
    const ed25519 = Ed25519.fromNoble(noble_ed25519)
    const x25519 = X25519.fromNoble(noble_x25519)
    const sha1 = Sha1.fromNoble(noble_sha1)

    const fallbacksUrl = "https://raw.githubusercontent.com/hazae41/echalote/master/tools/fallbacks/fallbacks.json"
    const fallbacks = await fetchAsJson<Fallback[]>(fallbacksUrl).then(r => r.unwrap())

    return new Mutex(new Pool<TorClientDuplex, Error>(async (params) => {
      return await Result.unthrow(async t => {
        const tor = await tryCreateLoop(async () => {
          const tcp = await createWebSocketSnowflakeStream("wss://snowflake.bamsoftware.com/")
          // const tcp =  await createMeekStream("https://meek.bamsoftware.com/")
          // const tcp =  await createWebSocketStream("ws://localhost:8080")

          const tor = new TorClientDuplex(tcp, { fallbacks, ed25519, x25519, sha1 })

          return await tor.tryWait().then(r => r.set(tor))
        }, params).then(r => r.throw(t))

        return new Ok(createPooledTor(tor, params))
      })
    }, params))
  }, [])
}

function useCircuitPool(tors?: Mutex<Pool<TorClientDuplex, Error>>, params?: PoolParams) {
  return useMemo(() => {
    if (!tors) return

    return new Mutex(new Pool<Circuit, Error>(async (params) => {
      return await Result.unthrow(async t => {
        const { index, signal } = params

        const tor = await tors.inner.tryGet(index % tors.inner.capacity).then(r => r.throw(t))
        const circuit = await tor.tryCreateAndExtendLoop(signal).then(r => r.throw(t))

        return new Ok(createPooledCircuit(circuit, params))
      })
    }, params))
  }, [tors])
}

async function fetchAsJson<T>(url: string) {
  const response = await fetch(url)

  if (!response.ok)
    return new Fail(new Error(await response.text()))
  return new Data(await response.json() as T)
}

async function fetchAsText(url: string) {
  const res = await fetch(url)

  if (!res.ok)
    return new Fail(new Error(await res.text()))
  return new Data(await res.text())
}

function getText(url: string) {
  return getSchema(url, fetchAsText)
}

function useText(url: string) {
  return useSchema(getText, [url])
}

async function tryFetchTorAsText(url: string, circuits: Mutex<Pool<Circuit, Error>>, init: FetcherMore) {
  const { signal } = init

  for (let i = 0; !signal?.aborted && i < 3; i++) {
    const circuit = await Pool.takeCryptoRandom(circuits).then(r => r.unwrap().result.get())

    const subsignal = AbortSignal.timeout(5_000)
    const response = await circuit.tryFetch(url, { signal: subsignal })

    if (response.isErr()) {
      console.warn(`Failed ${i + 1} time(s)`, { e: response.get() })
      await new Promise(ok => setTimeout(ok, 1000 * (2 ** i)))
      continue
    }

    if (!response.inner.ok)
      return new Fail(new Error(await response.get().text()))
    return new Data(await response.get().text())
  }

  if (signal?.aborted)
    return new Fail(new Error(`Aborted`, { cause: signal.reason }))
  return new Fail(new TooManyRetriesError())
}

function getTorText(url: string, pool?: Mutex<Pool<Circuit, Error>>) {
  if (!pool) return

  return getSchema(`tor:${url}`, async (_, init) => {
    return tryFetchTorAsText(url, pool, init)
  }, { timeout: 5 * 5_000 })
}

function useTorText(url: string, pool?: Mutex<Pool<Circuit, Error>>) {
  return useSchema(getTorText, [url, pool])
}

function usePoolSizeAndCapacity<T, E>(circuits?: Mutex<Pool<T, E>>) {
  const [sizeAndCapacity, setSizeAndCapacity] = useState<{ size: number, capacity: number }>()

  useEffect(() => {
    if (!circuits) return

    const onCreatedOrDeleted = () => {
      const { size, capacity } = circuits.inner
      setSizeAndCapacity({ size, capacity })
      return Ok.void()
    }

    const offCreated = circuits.inner.events.on("created", onCreatedOrDeleted, { passive: true })
    const offDeleted = circuits.inner.events.on("deleted", onCreatedOrDeleted, { passive: true })

    return () => {
      offCreated()
      offDeleted()
    }
  }, [circuits])

  return sizeAndCapacity
}

export default function Page() {
  const tors = useTorPool({ capacity: 3 })
  const circuits = useCircuitPool(tors, { capacity: 9 })

  const realIP = useText("https://icanhazip.com")
  const torIP = useTorText("https://icanhazip.com", circuits)

  const onClick = useCallback(() => {
    realIP.fetch()
    torIP.fetch()
  }, [realIP, torIP])

  const sizeAndCapacity = usePoolSizeAndCapacity(circuits)

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
    {sizeAndCapacity
      ? <div>
        Circuits pool size: {sizeAndCapacity.size} / {sizeAndCapacity.capacity}
      </div>
      : <div>
        Loading...
      </div>}
  </>
}