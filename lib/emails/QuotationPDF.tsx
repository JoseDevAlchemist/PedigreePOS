import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

import { formatAmount } from "@/lib/format";
import {
  calculateQuotationTotals,
  MPESA_TILL,
  QUOTATION_VALIDITY_DAYS,
  type QuotationData,
} from "@/lib/quotations";
import { formatEatDateTime } from "@/lib/time";

const BROWN = "#5d4037";
const GOLD = "#b8860b";
const INK = "#2f2926";
const MUTED = "#746a64";
const LINE = "#ded6cf";
const WELL = "#f7f3ef";

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingHorizontal: 40,
    paddingBottom: 48,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: INK,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  brandBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logo: {
    width: 44,
    height: 44,
    objectFit: "contain",
  },
  brandName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 15,
    letterSpacing: 2,
    color: BROWN,
  },
  brandTagline: {
    marginTop: 2,
    fontSize: 8,
    color: MUTED,
  },
  documentBlock: {
    alignItems: "flex-end",
  },
  documentTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 24,
    letterSpacing: 3,
    color: BROWN,
  },
  documentMeta: {
    marginTop: 4,
    fontSize: 8,
    color: MUTED,
  },
  customerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
    marginTop: 18,
    marginBottom: 18,
  },
  label: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 1.1,
    color: MUTED,
    textTransform: "uppercase",
  },
  customerName: {
    marginTop: 4,
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    color: INK,
  },
  customerLine: {
    marginTop: 3,
    color: MUTED,
  },
  infoBox: {
    width: 190,
    padding: 10,
    borderRadius: 4,
    backgroundColor: WELL,
  },
  infoLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  infoKey: {
    color: MUTED,
  },
  infoValue: {
    fontFamily: "Helvetica-Bold",
    color: INK,
  },
  table: {
    borderTopWidth: 1,
    borderTopColor: BROWN,
  },
  tableHead: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: WELL,
    paddingVertical: 7,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  colImage: {
    width: 42,
  },
  colItem: {
    flex: 1,
  },
  colColor: {
    width: 76,
  },
  colQty: {
    width: 32,
    textAlign: "right",
  },
  colUnit: {
    width: 70,
    textAlign: "right",
  },
  colTotal: {
    width: 74,
    textAlign: "right",
  },
  headText: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 0.8,
    color: MUTED,
    textTransform: "uppercase",
  },
  thumb: {
    width: 32,
    height: 32,
    borderRadius: 3,
    objectFit: "cover",
  },
  thumbEmpty: {
    width: 32,
    height: 32,
    borderRadius: 3,
    backgroundColor: WELL,
    borderWidth: 1,
    borderColor: LINE,
  },
  itemName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
  itemColor: {
    fontSize: 8,
    color: MUTED,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 12,
  },
  totalsBox: {
    width: 220,
  },
  totalsLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  totalsKey: {
    color: MUTED,
  },
  totalsValue: {
    fontFamily: "Helvetica-Bold",
  },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: BROWN,
  },
  grandTotalLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: BROWN,
  },
  grandTotalValue: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    color: BROWN,
  },
  paymentBox: {
    marginTop: 20,
    padding: 14,
    borderRadius: 5,
    backgroundColor: WELL,
    borderLeftWidth: 3,
    borderLeftColor: GOLD,
  },
  paymentTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: BROWN,
  },
  paymentLine: {
    marginTop: 5,
    fontSize: 9,
  },
  validity: {
    marginTop: 10,
    fontSize: 8,
    color: MUTED,
  },
  footer: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 20,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: MUTED,
  },
});

export function QuotationPDF({
  data,
  logoSrc,
  includeImages = true,
}: {
  data: QuotationData;
  logoSrc: string | null;
  includeImages?: boolean;
}) {
  const totals = calculateQuotationTotals(data);

  return (
    <Document
      title={`Quotation ${data.quotationNumber}`}
      author="Pedigree Leather"
      subject="Quotation"
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brandBlock}>
            {logoSrc !== null ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt prop
              <Image src={logoSrc} style={styles.logo} />
            ) : null}
            <View>
              <Text style={styles.brandName}>PEDIGREE LEATHER</Text>
              <Text style={styles.brandTagline}>
                Handcrafted bags and shoes — Nairobi
              </Text>
            </View>
          </View>
          <View style={styles.documentBlock}>
            <Text style={styles.documentTitle}>QUOTATION</Text>
            <Text style={styles.documentMeta}>{data.quotationNumber}</Text>
            <Text style={styles.documentMeta}>
              {formatEatDateTime(data.createdAt)}
            </Text>
          </View>
        </View>

        <View style={styles.customerRow}>
          <View>
            <Text style={styles.label}>Prepared for</Text>
            <Text style={styles.customerName}>{data.customerName}</Text>
            {data.customerPhone ? (
              <Text style={styles.customerLine}>{data.customerPhone}</Text>
            ) : null}
            {data.customerEmail ? (
              <Text style={styles.customerLine}>{data.customerEmail}</Text>
            ) : null}
          </View>
          <View style={styles.infoBox}>
            <View style={styles.infoLine}>
              <Text style={styles.infoKey}>Quote no.</Text>
              <Text style={styles.infoValue}>{data.quotationNumber}</Text>
            </View>
            <View style={styles.infoLine}>
              <Text style={styles.infoKey}>Valid for</Text>
              <Text style={styles.infoValue}>
                {QUOTATION_VALIDITY_DAYS} days
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={[styles.headText, styles.colImage]}>Image</Text>
            <Text style={[styles.headText, styles.colItem]}>Item</Text>
            <Text style={[styles.headText, styles.colColor]}>Color</Text>
            <Text style={[styles.headText, styles.colQty]}>Qty</Text>
            <Text style={[styles.headText, styles.colUnit]}>Unit price</Text>
            <Text style={[styles.headText, styles.colTotal]}>Total</Text>
          </View>

          {data.items.map((item, index) => (
            <View
              key={`${item.productId ?? item.name}-${index}`}
              style={styles.tableRow}
            >
              <View style={styles.colImage}>
                {includeImages &&
                item.imageUrl !== null &&
                item.imageUrl.length > 0 ? (
                  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt prop
                  <Image src={item.imageUrl} style={styles.thumb} />
                ) : (
                  <View style={styles.thumbEmpty} />
                )}
              </View>
              <View style={styles.colItem}>
                <Text style={styles.itemName}>{item.name}</Text>
              </View>
              <Text style={[styles.colColor, styles.itemColor]}>
                {item.color ?? "—"}
              </Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colUnit}>
                KES {formatAmount(item.unitPrice)}
              </Text>
              <Text style={styles.colTotal}>
                KES {formatAmount(item.unitPrice * item.quantity)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.totalsRow}>
          <View style={styles.totalsBox}>
            <View style={styles.totalsLine}>
              <Text style={styles.totalsKey}>Subtotal</Text>
              <Text style={styles.totalsValue}>
                KES {formatAmount(totals.subtotalKes)}
              </Text>
            </View>
            {totals.discountKes > 0 ? (
              <View style={styles.totalsLine}>
                <Text style={styles.totalsKey}>
                  Discount ({data.discountPercent}%)
                </Text>
                <Text style={styles.totalsValue}>
                  − KES {formatAmount(totals.discountKes)}
                </Text>
              </View>
            ) : null}
            <View style={styles.grandTotal}>
              <Text style={styles.grandTotalLabel}>TOTAL</Text>
              <Text style={styles.grandTotalValue}>
                KES {formatAmount(totals.totalKes)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.paymentBox}>
          <Text style={styles.paymentTitle}>PAYMENT DETAILS</Text>
          <Text style={styles.paymentLine}>
            Pay via M-Pesa Till: {MPESA_TILL}
          </Text>
          <Text style={styles.validity}>
            This quotation is valid for {QUOTATION_VALIDITY_DAYS} days.
          </Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>Pedigree Leather — Rosslyn Luxury Mall, Nairobi</Text>
          <Text>{data.quotationNumber}</Text>
        </View>
      </Page>
    </Document>
  );
}
