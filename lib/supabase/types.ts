/**
 * A hand-written subset of the generated Supabase types.
 *
 * The storefront has a 500-line `types.ts` generated from the whole schema. The
 * till touches five tables and one function, so this is the slice it actually
 * needs: less to keep in step, and `select()` on anything else is a type error
 * rather than a runtime surprise.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      products: {
        Row: {
          active: boolean;
          base_price: number;
          base_price_usd: number | null;
          barcode: string | null;
          category: string;
          created_at: string;
          description: string;
          discount_percent: number;
          featured: boolean;
          id: string;
          is_website_published: boolean;
          name: string;
          slug: string;
          stock_quantity: number;
        };
        Insert: {
          active?: boolean;
          base_price: number;
          base_price_usd?: number | null;
          barcode?: string | null;
          category: string;
          created_at?: string;
          description?: string;
          discount_percent?: number;
          featured?: boolean;
          id?: string;
          is_website_published?: boolean;
          name: string;
          slug: string;
          stock_quantity?: number;
        };
        Update: {
          active?: boolean;
          base_price?: number;
          base_price_usd?: number | null;
          barcode?: string | null;
          category?: string;
          created_at?: string;
          description?: string;
          discount_percent?: number;
          featured?: boolean;
          id?: string;
          is_website_published?: boolean;
          name?: string;
          slug?: string;
          stock_quantity?: number;
        };
        Relationships: [];
      };
      pos_users: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          name: string;
          pin_hash: string;
          role: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name: string;
          pin_hash: string;
          role: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name?: string;
          pin_hash?: string;
          role?: string;
        };
        Relationships: [];
      };
      pos_sales: {
        Row: {
          amount_tendered: number | null;
          cashier_id: string | null;
          cashier_name: string;
          change_due: number | null;
          client_uuid: string;
          created_at: string;
          discount_kes: number;
          discount_percent: number;
          id: string;
          mpesa_code: string | null;
          payment_method: string;
          stock_applied_at: string | null;
          subtotal_kes: number;
          synced_at: string | null;
          total_kes: number;
        };
        Insert: {
          amount_tendered?: number | null;
          cashier_id?: string | null;
          cashier_name: string;
          change_due?: number | null;
          client_uuid: string;
          created_at?: string;
          discount_kes?: number;
          discount_percent?: number;
          id: string;
          mpesa_code?: string | null;
          payment_method: string;
          stock_applied_at?: string | null;
          subtotal_kes?: number;
          synced_at?: string | null;
          total_kes: number;
        };
        Update: {
          amount_tendered?: number | null;
          cashier_id?: string | null;
          cashier_name?: string;
          change_due?: number | null;
          client_uuid?: string;
          created_at?: string;
          discount_kes?: number;
          discount_percent?: number;
          id?: string;
          mpesa_code?: string | null;
          payment_method?: string;
          stock_applied_at?: string | null;
          subtotal_kes?: number;
          synced_at?: string | null;
          total_kes?: number;
        };
        Relationships: [];
      };
      pos_sale_items: {
        Row: {
          id: string;
          price_at_sale: number;
          product_id: string | null;
          product_name: string;
          quantity: number;
          sale_id: string;
        };
        Insert: {
          id: string;
          price_at_sale: number;
          product_id?: string | null;
          product_name: string;
          quantity: number;
          sale_id: string;
        };
        Update: {
          id?: string;
          price_at_sale?: number;
          product_id?: string | null;
          product_name?: string;
          quantity?: number;
          sale_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      pos_record_sale: {
        Args: {
          p_client_uuid: string;
          p_cashier_id: string | null;
          p_cashier_name: string;
          p_subtotal_kes: number;
          p_discount_kes: number;
          p_discount_percent: number;
          p_total_kes: number;
          p_payment_method: string;
          p_amount_tendered: number | null;
          p_change_due: number | null;
          p_mpesa_code: string | null;
          p_created_at: string;
          p_items: Json;
        };
        Returns: boolean;
      };
      pos_daily_totals: {
        Args: { p_day?: string };
        Returns: {
          payment_method: string;
          sale_count: number;
          gross_kes: number;
        }[];
      };
      pos_record_return: {
        Args: {
          p_client_uuid: string;
          p_original_sale_id: string | null;
          p_cashier_id: string | null;
          p_cashier_name: string;
          p_manager_id: string | null;
          p_manager_name: string;
          p_items: Json;
        };
        Returns: boolean;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
