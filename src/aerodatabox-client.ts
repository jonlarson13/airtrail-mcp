const BASE_URL = "https://aerodatabox.p.rapidapi.com";
const REQUEST_TIMEOUT_MS = 15_000;

function sanitizeFlightNumber(flightNumber: string): string {
  return flightNumber.replace(/\s|-/g, "").toUpperCase();
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface RawAedbxTime {
  local?: string;
}

interface RawAedbxAirport {
  icao?: string;
  iata?: string;
}

interface RawAedbxFlight {
  departure: {
    airport: RawAedbxAirport;
    terminal?: string;
    gate?: string;
    scheduledTime?: RawAedbxTime;
    revisedTime?: RawAedbxTime;
    actualTime?: RawAedbxTime;
  };
  arrival: {
    airport: RawAedbxAirport;
    terminal?: string;
    gate?: string;
    scheduledTime?: RawAedbxTime;
    revisedTime?: RawAedbxTime;
    actualTime?: RawAedbxTime;
  };
  airline?: { icao?: string; iata?: string };
  aircraft?: { reg?: string };
}

export interface AerodataboxFlightMatch {
  from: string | null;
  fromIata: string | null;
  to: string | null;
  toIata: string | null;
  departureScheduled: string | null;
  departureActual: string | null;
  departureTerminal: string | null;
  departureGate: string | null;
  arrivalScheduled: string | null;
  arrivalActual: string | null;
  arrivalTerminal: string | null;
  arrivalGate: string | null;
  airlineIcao: string | null;
  airlineIata: string | null;
  aircraftReg: string | null;
}

export interface AerodataboxAircraft {
  icaoCode: string | null;
  model: string | null;
  registration: string;
}

function localToIso(local: string | undefined): string | null {
  // AeroDataBox returns local timestamps like "2024-06-01 14:30+02:00"
  if (!local) return null;
  return local.replace(" ", "T");
}

export class AerodataboxClient {
  constructor(private readonly apiKey: string) {}

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        headers: { "x-rapidapi-key": this.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`AeroDataBox request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    if (response.status === 204) {
      throw new Error("No matching data found");
    }
    if (!response.ok) {
      throw new Error(`AeroDataBox request failed with status ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`AeroDataBox returned a non-JSON response (status ${response.status})`);
    }
  }

  async lookupFlight(flightNumber: string, date?: string): Promise<AerodataboxFlightMatch[]> {
    const cleaned = sanitizeFlightNumber(flightNumber);

    let path: string;
    if (date) {
      path = `/flights/number/${encodeURIComponent(cleaned)}/${encodeURIComponent(date)}?dateLocalRole=Both&withAircraftImage=false&withLocation=false`;
    } else {
      const now = new Date();
      const fromDate = formatDate(new Date(now.getTime() - 2 * 86400000));
      const toDate = formatDate(new Date(now.getTime() + 2 * 86400000));
      path = `/flights/number/${encodeURIComponent(cleaned)}/${fromDate}/${toDate}?dateLocalRole=Both&withAircraftImage=false&withLocation=false`;
    }

    const data = await this.get<RawAedbxFlight[]>(path);
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("No matching flights found");
    }

    return data
      .filter((item) => item.departure?.airport?.icao && item.arrival?.airport?.icao)
      .map((item) => ({
        from: item.departure.airport.icao ?? null,
        fromIata: item.departure.airport.iata ?? null,
        to: item.arrival.airport.icao ?? null,
        toIata: item.arrival.airport.iata ?? null,
        departureScheduled: localToIso(item.departure.scheduledTime?.local),
        departureActual: localToIso(item.departure.actualTime?.local ?? item.departure.revisedTime?.local),
        departureTerminal: item.departure.terminal ?? null,
        departureGate: item.departure.gate ?? null,
        arrivalScheduled: localToIso(item.arrival.scheduledTime?.local),
        arrivalActual: localToIso(item.arrival.actualTime?.local ?? item.arrival.revisedTime?.local),
        arrivalTerminal: item.arrival.terminal ?? null,
        arrivalGate: item.arrival.gate ?? null,
        airlineIcao: item.airline?.icao ?? null,
        airlineIata: item.airline?.iata ?? null,
        aircraftReg: item.aircraft?.reg ?? null,
      }));
  }

  async lookupAircraftByReg(registration: string): Promise<AerodataboxAircraft | null> {
    const data = await this.get<{ icaoCode?: string; model?: string }>(
      `/aircrafts/reg/${encodeURIComponent(registration)}`,
    );
    if (!data?.icaoCode) return null;
    return { icaoCode: data.icaoCode, model: data.model ?? null, registration };
  }
}
