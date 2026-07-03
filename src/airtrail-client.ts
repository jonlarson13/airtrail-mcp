const REQUEST_TIMEOUT_MS = 20_000;

export interface AirtrailClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class AirtrailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AirtrailApiError";
  }
}

export class AirtrailClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(options: AirtrailClientOptions) {
    this.apiUrl = `${options.baseUrl.replace(/\/+$/, "")}/api`;
    this.apiKey = options.apiKey;
  }

  private async request<T>(
    path: string,
    init: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`AirTrail request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    const text = await response.text();
    let data: any;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        console.error(`AirTrail returned a non-JSON response for ${path} (status ${response.status}):\n${text.slice(0, 1000)}`);
        throw new AirtrailApiError(
          response.status,
          `AirTrail returned a non-JSON response (status ${response.status}). Check that AIRTRAIL_BASE_URL points directly at the AirTrail instance, not a login page or proxy.`,
        );
      }
    }

    if (!response.ok) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (Array.isArray(data?.errors) && data.errors.join("; ")) ||
        `AirTrail API request failed with status ${response.status}`;
      throw new AirtrailApiError(response.status, message);
    }

    return data as T;
  }

  listFlights(params: { scope?: "mine" | "user" | "all"; userId?: string }) {
    return this.request<{ success: boolean; flights: unknown[] }>("/flight/list", {
      query: { scope: params.scope, userId: params.userId },
    });
  }

  getFlight(id: number) {
    return this.request<{ success: boolean; flight: unknown }>(`/flight/get/${id}`);
  }

  saveFlight(flight: Record<string, unknown>) {
    return this.request<{ success: boolean; id?: number }>("/flight/save", {
      method: "POST",
      body: flight,
    });
  }

  deleteFlight(id: number) {
    return this.request<{ success: boolean }>("/flight/delete", {
      method: "POST",
      body: { id },
    });
  }

  exportFlights(params: { format?: "json" | "yaml" | "yml"; scope?: "mine" | "user" | "all"; userId?: string }) {
    return this.request<unknown>("/flight/export", {
      query: { format: params.format, scope: params.scope, userId: params.userId },
    });
  }
}
