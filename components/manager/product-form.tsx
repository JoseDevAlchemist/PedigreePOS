"use client";

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Image as ImageIcon, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";

import { AppHeader } from "@/components/app-header";
import { ManagerNav } from "@/components/manager/manager-nav";
import { SyncProvider } from "@/components/sync-provider";
import { getDb, newUuid, nowIso, type LocalProduct } from "@/lib/db";
import { addSyncQueueEntry } from "@/lib/sync";
import { cn } from "@/lib/cn";
import { formatAmount } from "@/lib/format";

/**
 * Adding a product from the till.
 *
 * Fields: name, category, price, opening stock, optional barcode, colours and
 * image. There is deliberately no description — the till captures what the
 * shop floor needs, nothing more. The product row is queued for Supabase; the
 * image and colourways stay on this till until a media/colour upload path
 * exists.
 */

const DEFAULT_COLORS = ["Black", "Brown", "Tan", "Cognac", "Navy", "Green", "Red", "White"];
const MAX_IMAGE_EDGE = 1200;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ProductCategory = "bag" | "shoe";

/**
 * Read an image, cap its long edge, and encode it as WebP/JPEG.
 *
 * The original data URL is returned untouched when the image is already small
 * in both dimensions and bytes. A 5 MB phone photo is the case this exists for:
 * it must not be stored twice as base64, and it does not need to be wider than a
 * product card.
 */
async function resizeProductImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Could not decode the image."));
    element.src = dataUrl;
  });

  const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
  if (longestEdge === 0) return dataUrl;

  const scale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
  if (scale === 1 && file.size <= 750 * 1024) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  if (context === null) return dataUrl;

  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const webp = canvas.toDataURL("image/webp", 0.82);
  return webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL("image/jpeg", 0.82);
}

interface ProductFormProps {
  onSaved?: (product: LocalProduct) => void;
}

export function ProductForm({ onSaved }: ProductFormProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ProductCategory>("bag");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [barcode, setBarcode] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [colors, setColors] = useState<string[]>([]);
  const [customColor, setCustomColor] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [processingImage, setProcessingImage] = useState(false);
  const [isWebsitePublished, setIsWebsitePublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const products = useLiveQuery(
    () => getDb().products.orderBy("name").toArray(),
    [],
    [] as LocalProduct[],
  );

  function slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function toggleColor(color: string) {
    setColors((current) =>
      current.includes(color) ? current.filter((c) => c !== color) : [...current, color],
    );
  }

  function addCustomColor() {
    const color = customColor.trim();
    if (color.length === 0 || colors.includes(color)) return;
    setColors([...colors, color]);
    setCustomColor("");
  }

  function removeColor(color: string) {
    setColors((current) => current.filter((c) => c !== color));
  }

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file === null) return;

    if (!file.type.startsWith("image/")) {
      setError("Please upload an image file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Please choose an image under 10 MB.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setProcessingImage(true);
    setError(null);

    try {
      setImageUrl(await resizeProductImage(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the image.");
    } finally {
      setProcessingImage(false);
      // Allow selecting the same file again after a resize or an error.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeImage() {
    setImageUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const basePrice = price.trim() === "" ? 0 : Number.parseInt(price, 10);
  const openingStock = stock.trim() === "" ? 0 : Number.parseInt(stock, 10);
  const barcodeValue = barcode.trim();
  const qrCodeValue = qrCode.trim();
  const priceValid = Number.isSafeInteger(basePrice) && basePrice > 0;
  const stockValid = Number.isSafeInteger(openingStock) && openingStock >= 0;
  const canSubmit =
    !saving &&
    !processingImage &&
    name.trim().length >= 2 &&
    priceValid &&
    stockValid &&
    colors.length > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);

    try {
      const db = getDb();
      const nameValue = name.trim();
      const id = newUuid();
      const baseSlug = slugify(nameValue) || `product-${id.slice(0, 8)}`;
      const product: LocalProduct = {
        id,
        name: nameValue,
        slug: baseSlug,
        category,
        barcode: barcodeValue === "" ? null : barcodeValue,
        qrCode: qrCodeValue === "" ? null : qrCodeValue,
        basePrice,
        discountPercent: 0,
        stockQuantity: openingStock,
        active: true,
        imageUrl,
        updatedAt: nowIso(),
        colors,
        isWebsitePublished,
      };

      await db.transaction("rw", db.products, db.sync_queue, async () => {
        if (barcodeValue !== "") {
          const duplicate = await db.products
            .where("barcode")
            .equals(barcodeValue)
            .first();
          if (duplicate) {
            throw new Error(
              `Barcode ${barcodeValue} is already used by ${duplicate.name}.`,
            );
          }
        }

        // Keep the local slug unique too. The RPC handles a collision with a
        // product the server already has; this handles one queued offline.
        if ((await db.products.where("slug").equals(product.slug).count()) > 0) {
          product.slug = `${baseSlug}-${id.slice(0, 8)}`;
        }

        await db.products.add(product);

        await addSyncQueueEntry({
          entity: "product",
          entityId: product.id,
          payload: {
            name: product.name,
            slug: product.slug,
            category: product.category,
            barcode: product.barcode,
            qrCode: product.qrCode ?? null,
            basePrice: product.basePrice,
            stockQuantity: product.stockQuantity,
            colors: product.colors,
            isWebsitePublished: product.isWebsitePublished,
          },
          createdAt: product.updatedAt,
          updatedAt: product.updatedAt,
        });
      });

      setAdded(nameValue);
      setName("");
      setCategory("bag");
      setPrice("");
      setStock("0");
      setBarcode("");
      setQrCode("");
      setColors([]);
      setCustomColor("");
      setImageUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setIsWebsitePublished(false);
      void onSaved?.(product);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the product.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SyncProvider />
      <AppHeader current="manager" />

      <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-6 px-4 py-6 lg:px-8">
        <header>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">
            Add product
          </h1>
          <p className="mt-1 text-sm text-muted">
            Product details and opening stock are saved on this till and queued
            for Supabase. Image and colourways stay local. The product is not
            published to the website unless you check the box below.
          </p>
        </header>

        <ManagerNav current="inventory" />

        {error !== null ? (
          <p role="alert" className="rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <section
          aria-label="Add a product"
          className="flex h-fit flex-col gap-5 rounded-3xl border border-border bg-card p-5 shadow-card"
        >
          <header className="flex items-center gap-2">
            <Plus aria-hidden="true" className="size-4 text-primary" />
            <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
              New product
            </h2>
          </header>

          <form onSubmit={submit} className="flex flex-col gap-5">
            <div>
              <label htmlFor="product-name" className="text-sm font-semibold text-foreground">
                Product name
              </label>
              <input
                id="product-name"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Karura Tote"
                className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm text-foreground transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="product-category" className="text-sm font-semibold text-foreground">
                  Category
                </label>
                <select
                  id="product-category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value as ProductCategory)}
                  className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors outline-none focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <option value="bag">Bag</option>
                  <option value="shoe">Shoe</option>
                </select>
              </div>

              <div>
                <label htmlFor="product-price" className="text-sm font-semibold text-foreground">
                  Price (KES)
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-sm font-semibold text-muted">KES</span>
                  <input
                    id="product-price"
                    autoComplete="off"
                    inputMode="numeric"
                    value={price}
                    onChange={(event) => setPrice(event.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="0"
                    className="h-12 flex-1 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                </div>
                {price !== "" && !priceValid ? (
                  <p className="mt-1 text-xs text-danger">
                    Price must be greater than 0.
                  </p>
                ) : basePrice > 0 ? (
                  <p className="mt-1 text-xs text-muted">
                    {formatAmount(basePrice)} per unit
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="product-stock" className="text-sm font-semibold text-foreground">
                  Opening stock
                </label>
                <input
                  id="product-stock"
                  autoComplete="off"
                  inputMode="numeric"
                  value={stock}
                  onChange={(event) => setStock(event.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="0"
                  className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <p className="mt-1 text-xs text-muted">
                  Units on the shelf right now.
                </p>
              </div>

              <div>
                <label htmlFor="product-barcode" className="text-sm font-semibold text-foreground">
                  Barcode <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  id="product-barcode"
                  autoComplete="off"
                  value={barcode}
                  maxLength={64}
                  onChange={(event) => setBarcode(event.target.value)}
                  placeholder="Scan or type a barcode"
                  className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <p className="mt-1 text-xs text-muted">
                  Used by the scanner; must be unique in the catalogue. Leave
                  blank if the product has none.
                </p>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="product-qr-code" className="text-sm font-semibold text-foreground">
                  QR Code / Bag Serial Number <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  id="product-qr-code"
                  autoComplete="off"
                  value={qrCode}
                  onChange={(event) => setQrCode(event.target.value)}
                  placeholder="Scan or type the bag serial number"
                  className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <p className="mt-1 text-xs text-muted">
                  Scanned at the counter to add the bag to a sale. Leave blank
                  if the product has none.
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="product-colors" className="text-sm font-semibold text-foreground">
                Colourways <span className="font-normal text-muted">(till only)</span>
              </label>
              <p className="mt-1 text-xs text-muted">
                Saved on this till for the manager&apos;s view. They are not
                uploaded to the website yet.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DEFAULT_COLORS.map((color) => {
                  const active = colors.includes(color);
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => toggleColor(color)}
                      aria-pressed={active}
                      className={cn(
                        "rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                        active
                          ? "border-primary bg-primary text-cream"
                          : "border-border bg-card text-muted hover:border-primary/35 hover:text-primary",
                      )}
                    >
                      {color}
                    </button>
                  );
                })}
                <div className="flex items-center gap-2">
                  <input
                    id="product-custom-color"
                    value={customColor}
                    onChange={(event) => setCustomColor(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomColor();
                      }
                    }}
                    placeholder="e.g. Olive"
                    className="h-9 rounded-xl border border-border bg-card px-3 text-xs text-foreground transition-colors outline-none focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                  <button
                    type="button"
                    onClick={addCustomColor}
                    disabled={customColor.trim().length === 0 || colors.includes(customColor.trim())}
                    className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-muted transition-colors hover:bg-well disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Add
                  </button>
                </div>
              </div>
              {colors.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {colors.map((color) => (
                    <span
                      key={color}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-well px-2.5 py-1 text-xs font-semibold text-muted"
                    >
                      {color}
                      <button
                        type="button"
                        onClick={() => removeColor(color)}
                        aria-label={`Remove ${color}`}
                        className="ml-1 rounded-lg p-0.5 text-muted/60 hover:bg-danger hover:text-danger-ink focus:outline-none"
                      >
                        <Trash2 aria-hidden="true" className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {colors.length === 0 ? (
                <p className="mt-2 text-xs text-danger">
                  Choose at least one colourway.
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="product-image" className="text-sm font-semibold text-foreground">
                Image <span className="font-normal text-muted">(till only)</span>
              </label>
              <p className="mt-1 text-xs text-muted">
                Shown on this till. Resized to at most 1200px and stored
                locally; it is not uploaded to the website yet.
              </p>
              <div className="mt-2 flex flex-col gap-2">
                <input
                  id="product-image"
                  type="file"
                  accept="image/*"
                  ref={fileInputRef}
                  onChange={handleImageChange}
                  disabled={processingImage}
                  className="block w-full text-sm text-muted file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border file:border-border file:bg-card file:text-sm file:font-semibold disabled:opacity-60"
                />
                {processingImage ? (
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                    Preparing image…
                  </p>
                ) : null}
                {imageUrl !== null ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data URL; next/image cannot optimize it */}
                    <img
                      src={imageUrl}
                      alt="Product preview"
                      className="h-20 w-20 rounded-xl object-cover border border-border"
                    />
                    <button
                      type="button"
                      onClick={removeImage}
                      aria-label="Remove image"
                      className="rounded-xl p-1.5 text-muted hover:bg-danger hover:text-danger-ink focus:outline-none"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex items-center gap-3">
                <input
                  id="product-published"
                  type="checkbox"
                  checked={isWebsitePublished}
                  onChange={(event) => setIsWebsitePublished(event.target.checked)}
                  className="rounded border-border bg-card text-primary focus:ring-primary"
                />
                <label
                  htmlFor="product-published"
                  className="cursor-pointer text-sm font-semibold text-foreground"
                >
                  Publish product details on the website
                </label>
              </div>
              <p className="text-xs text-muted sm:ml-auto sm:text-right">
                <span className={cn(isWebsitePublished ? "text-danger" : "text-muted")}>
                  {isWebsitePublished
                    ? "Details go live; image and colours stay on this till"
                    : "Stays off the storefront"}
                </span>
              </p>
            </div>

            {added !== null ? (
              <p
                role="status"
                className="inline-flex items-center gap-1.5 rounded-xl bg-success-soft px-3 py-2 text-sm font-semibold text-success"
              >
                <Check aria-hidden="true" className="size-4" />
                {added} added to the catalogue and queued for Supabase.
              </p>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {saving ? (
                <>
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <ShieldCheck aria-hidden="true" className="size-4" />
                  Save product
                </>
              )}
            </button>
          </form>
        </section>

        <section
          aria-label="Products on this till"
          className="overflow-hidden rounded-3xl border border-border bg-card shadow-card"
        >
          <header className="flex items-center gap-2 border-b border-border px-5 py-4">
            <ImageIcon aria-hidden="true" className="size-4 text-primary" />
            <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
              Products on this till
            </h2>
            <span className="rounded-full bg-well px-2 py-0.5 text-xs font-semibold text-muted tabular-nums">
              {products.length}
            </span>
          </header>

          {products.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted">
              No products on this till yet. Add one above, or wait for the
              catalogue to sync.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {products.map((product) => (
                <li key={product.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-well text-[0.6875rem] font-semibold text-primary overflow-hidden"
                  >
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- offline-first, same as the till grid
                      <img
                        src={product.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      product.name.charAt(0).toUpperCase()
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {product.name}
                    </p>
                    <p className="text-xs text-muted">
                      {product.category} · KES {formatAmount(product.basePrice)} ·
                      {(product.colors ?? []).join(", ") || "no colours"} ·{" "}
                      {product.isWebsitePublished
                        ? "published"
                        : "not on website"}
                    </p>
                  </div>
                  <span className="text-right font-mono text-xs text-muted tabular-nums">
                    {product.stockQuantity} in stock
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
