/**
 * Type declarations for `@point-of-sale/webserial-customer-display`.
 *
 * The package ships without TypeScript types, so the shapes the till relies on
 * are declared here: the `WebSerialCustomerDisplay` class (Web Serial connect /
 * line / clear API) and the event payloads it emits.
 */

declare module "@point-of-sale/webserial-customer-display" {
  export interface WebSerialCustomerDisplayOptions {
    /** `"auto"` detects the display language from the USB vendor id;
     * `"bixolon"` or `"digipos"` force it. Defaults to `"auto"`. */
    language?: "auto" | "bixolon" | "digipos";
    baudRate?: number;
    bufferSize?: number;
    dataBits?: number;
    flowControl?: "none" | "hardware";
    parity?: "none" | "even" | "odd";
    stopBits?: number;
  }

  export interface WebSerialConnectedDevice {
    type: "serial";
    language: string;
    vendorId: number | null;
    productId: number | null;
  }

  export interface WebSerialDevice {
    vendorId: number;
    productId: number;
  }

  export default class WebSerialCustomerDisplay {
    constructor(options?: WebSerialCustomerDisplayOptions);

    /** Must be triggered by a user gesture (e.g. a Connect button). */
    connect(): Promise<void>;

    /** Reconnect to a previously used device via its vendor/product id. */
    reconnect(device: WebSerialDevice): Promise<void>;

    disconnect(): Promise<void>;

    clear(): Promise<void>;

    /**
     * Write one line. Accepts a single string or a two-string array (line 1,
     * line 2). Lines are truncated to 20 characters.
     */
    line(text: string | [string, string]): Promise<void>;

    addEventListener(
      type: "connected" | "disconnected",
      listener: (event: WebSerialConnectedDevice) => void,
    ): void;
  }
}
