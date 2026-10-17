import Image from "next/image";

/**
 * The Pedigree lockup.
 *
 * One component so the logo is never re-exported at a different size or with a
 * different alt text. The image is a full lockup — mark, wordmark and tagline —
 * drawn on a transparent circle, so it is placed on a surface rather than
 * tinted or cropped.
 */
export function BrandMark({
  size = 44,
  tagline = false,
  className,
}: {
  size?: number;
  /** Show the "Pedigree POS" descriptor beside the lockup. */
  tagline?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-3 ${className ?? ""}`}>
      <Image
        src="/pedigree-logo.png"
        alt="Pedigree Leather"
        width={size}
        height={size}
        priority
        className="rounded-full"
      />
      {tagline ? (
        <span className="flex flex-col leading-none">
          <span className="font-serif text-lg font-semibold tracking-tight text-foreground">
            Pedigree
          </span>
          <span className="text-[0.6875rem] font-semibold tracking-[0.22em] text-muted uppercase">
            Point of Sale
          </span>
        </span>
      ) : null}
    </span>
  );
}
