import { createWebSocketSnowflakeStream, Tor } from "@hazae41/echalote";
import { getSingleSchema, useQuery } from "@hazae41/xswr";
import { DependencyList, useCallback, useEffect, useState } from "react";
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

async function createCircuit(tor: Tor) {
  while (true)
    try {
      const circuit = await tor.create()

      await circuit.extend(false)
      await circuit.extend(true)

      return circuit
    } catch (e: unknown) {
      console.warn("Create failed", e)
      await new Promise(ok => setTimeout(ok, 1000))
    }
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

async function fetchTorText(url: string, tor: Tor) {
  const circuit = await createCircuit(tor)
  const res = await circuit.fetch(url)

  if (!res.ok) {
    const error = new Error(await res.text())
    return { error }
  }

  const data = await res.text()
  return { data }
}

function getTorText(url: string, tor?: Tor) {
  const key = tor ? `tor:${url}` : undefined
  const fetcher = tor ? () => fetchTorText(url, tor!) : undefined
  return getSingleSchema(key, fetcher)
}

function useTorText(url: string, tor?: Tor) {
  return useQuery(getTorText, [url, tor])
}

export default function Page() {
  const tor = useTor()

  const realIP = useText("https://icanhazip.com")
  const torIP = useTorText("https://icanhazip.com", tor)

  const onClick = useCallback(() => {
    realIP.fetch()
    torIP.fetch()
  }, [torIP])

  return <>
    Open browser console and <button onClick={onClick}>click me</button>
    <div>
      {`Your real IP address is: `}
      {realIP.loading
        ? <>Loading...</>
        : <>{realIP.data}</>}
    </div>
    <div>
      {`Your Tor IP address is: `}
      {torIP.loading
        ? <>Loading...</>
        : <>{torIP.data}</>}
    </div>
  </>
}