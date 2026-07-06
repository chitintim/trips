export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity_feed: {
        Row: {
          actor: string | null
          created_at: string
          entity: Json | null
          id: string
          metadata: Json | null
          trip_id: string
          verb: string
        }
        Insert: {
          actor?: string | null
          created_at?: string
          entity?: Json | null
          id?: string
          metadata?: Json | null
          trip_id: string
          verb: string
        }
        Update: {
          actor?: string | null
          created_at?: string
          entity?: Json | null
          id?: string
          metadata?: Json | null
          trip_id?: string
          verb?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_feed_actor_fkey"
            columns: ["actor"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_feed_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_proposals: {
        Row: {
          actions: Json
          applied_at: string | null
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          reviewed_by: string | null
          source_text: string | null
          status: string
          trip_id: string
        }
        Insert: {
          actions: Json
          applied_at?: string | null
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          reviewed_by?: string | null
          source_text?: string | null
          status?: string
          trip_id: string
        }
        Update: {
          actions?: Json
          applied_at?: string | null
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          reviewed_by?: string | null
          source_text?: string | null
          status?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_proposals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage: {
        Row: {
          cache_read_tokens: number | null
          cache_write_tokens: number | null
          created_at: string
          estimated_cost_usd: number | null
          function_name: string
          id: string
          input_tokens: number | null
          model: string
          output_tokens: number | null
          trip_id: string | null
          user_id: string | null
        }
        Insert: {
          cache_read_tokens?: number | null
          cache_write_tokens?: number | null
          created_at?: string
          estimated_cost_usd?: number | null
          function_name: string
          id?: string
          input_tokens?: number | null
          model: string
          output_tokens?: number | null
          trip_id?: string | null
          user_id?: string | null
        }
        Update: {
          cache_read_tokens?: number | null
          cache_write_tokens?: number | null
          created_at?: string
          estimated_cost_usd?: number | null
          function_name?: string
          id?: string
          input_tokens?: number | null
          model?: string
          output_tokens?: number | null
          trip_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          amount: number | null
          booked_by: string
          booking_date: string | null
          cancellation_deadline: string | null
          confirmation_ref: string | null
          created_at: string
          currency: string | null
          document_url: string | null
          expense_id: string | null
          id: string
          notes: string | null
          option_id: string | null
          place_id: string | null
          refundable: boolean | null
          status: string
          timeline_event_id: string | null
          title: string
          trip_id: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount?: number | null
          booked_by: string
          booking_date?: string | null
          cancellation_deadline?: string | null
          confirmation_ref?: string | null
          created_at?: string
          currency?: string | null
          document_url?: string | null
          expense_id?: string | null
          id?: string
          notes?: string | null
          option_id?: string | null
          place_id?: string | null
          refundable?: boolean | null
          status?: string
          timeline_event_id?: string | null
          title: string
          trip_id: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount?: number | null
          booked_by?: string
          booking_date?: string | null
          cancellation_deadline?: string | null
          confirmation_ref?: string | null
          created_at?: string
          currency?: string | null
          document_url?: string | null
          expense_id?: string | null
          id?: string
          notes?: string | null
          option_id?: string | null
          place_id?: string | null
          refundable?: boolean | null
          status?: string
          timeline_event_id?: string | null
          title?: string
          trip_id?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookings_booked_by_fkey"
            columns: ["booked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_timeline_event_id_fkey"
            columns: ["timeline_event_id"]
            isOneToOne: false
            referencedRelation: "trip_timeline_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          content: string
          created_at: string
          id: string
          option_id: string | null
          section_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          option_id?: string | null
          section_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          option_id?: string | null
          section_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "planning_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_allocation_links: {
        Row: {
          code: string
          created_at: string | null
          created_by: string
          expense_id: string
          expires_at: string | null
          id: string
          trip_id: string
        }
        Insert: {
          code: string
          created_at?: string | null
          created_by: string
          expense_id: string
          expires_at?: string | null
          id?: string
          trip_id: string
        }
        Update: {
          code?: string
          created_at?: string | null
          created_by?: string
          expense_id?: string
          expires_at?: string | null
          id?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_allocation_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_allocation_links_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_allocation_links_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_item_claims: {
        Row: {
          amount_owed: number
          claimed_at: string | null
          confirmed: boolean | null
          expense_id: string
          id: string
          line_item_id: string
          quantity_claimed: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          amount_owed: number
          claimed_at?: string | null
          confirmed?: boolean | null
          expense_id: string
          id?: string
          line_item_id: string
          quantity_claimed: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          amount_owed?: number
          claimed_at?: string | null
          confirmed?: boolean | null
          expense_id?: string
          id?: string
          line_item_id?: string
          quantity_claimed?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_item_claims_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_item_claims_line_item_id_fkey"
            columns: ["line_item_id"]
            isOneToOne: false
            referencedRelation: "expense_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_item_claims_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_line_items: {
        Row: {
          created_at: string | null
          expense_id: string
          id: string
          line_discount_amount: number | null
          line_discount_percent: number | null
          line_number: number
          name_english: string | null
          name_original: string
          notes: string | null
          quantity: number
          service_amount: number | null
          subtotal: number
          tax_amount: number | null
          total_amount: number
          unit_price: number
        }
        Insert: {
          created_at?: string | null
          expense_id: string
          id?: string
          line_discount_amount?: number | null
          line_discount_percent?: number | null
          line_number: number
          name_english?: string | null
          name_original: string
          notes?: string | null
          quantity: number
          service_amount?: number | null
          subtotal: number
          tax_amount?: number | null
          total_amount: number
          unit_price: number
        }
        Update: {
          created_at?: string | null
          expense_id?: string
          id?: string
          line_discount_amount?: number | null
          line_discount_percent?: number | null
          line_number?: number
          name_english?: string | null
          name_original?: string
          notes?: string | null
          quantity?: number
          service_amount?: number | null
          subtotal?: number
          tax_amount?: number | null
          total_amount?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "expense_line_items_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_splits: {
        Row: {
          amount: number
          base_currency_amount: number | null
          created_at: string
          expense_id: string
          id: string
          percentage: number | null
          shares: number | null
          split_type: Database["public"]["Enums"]["split_type"]
          user_id: string
        }
        Insert: {
          amount: number
          base_currency_amount?: number | null
          created_at?: string
          expense_id: string
          id?: string
          percentage?: number | null
          shares?: number | null
          split_type?: Database["public"]["Enums"]["split_type"]
          user_id: string
        }
        Update: {
          amount?: number
          base_currency_amount?: number | null
          created_at?: string
          expense_id?: string
          id?: string
          percentage?: number | null
          shares?: number | null
          split_type?: Database["public"]["Enums"]["split_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_splits_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_splits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          ai_parsed: boolean | null
          ai_parsed_data: Json | null
          amount: number
          base_currency_amount: number | null
          booking_id: string | null
          category: Database["public"]["Enums"]["expense_category"]
          created_at: string
          currency: string
          description: string
          discount_amount: number | null
          discount_percent: number | null
          fx_rate: number | null
          fx_rate_date: string | null
          id: string
          location: string | null
          option_id: string | null
          paid_by: string
          parsing_error: string | null
          participant_ids: string[] | null
          payment_date: string
          place_id: string | null
          rate_source: string | null
          receipt_date: string | null
          receipt_url: string | null
          rounding_adjustment: number | null
          service_charge_amount: number | null
          service_charge_percent: number | null
          status: Database["public"]["Enums"]["expense_status"] | null
          subtotal: number | null
          tax_amount: number | null
          tax_lines: Json | null
          tax_percent: number | null
          tip_amount: number | null
          trip_id: string
          updated_at: string
          vendor_name: string | null
        }
        Insert: {
          ai_parsed?: boolean | null
          ai_parsed_data?: Json | null
          amount: number
          base_currency_amount?: number | null
          booking_id?: string | null
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description: string
          discount_amount?: number | null
          discount_percent?: number | null
          fx_rate?: number | null
          fx_rate_date?: string | null
          id?: string
          location?: string | null
          option_id?: string | null
          paid_by: string
          parsing_error?: string | null
          participant_ids?: string[] | null
          payment_date?: string
          place_id?: string | null
          rate_source?: string | null
          receipt_date?: string | null
          receipt_url?: string | null
          rounding_adjustment?: number | null
          service_charge_amount?: number | null
          service_charge_percent?: number | null
          status?: Database["public"]["Enums"]["expense_status"] | null
          subtotal?: number | null
          tax_amount?: number | null
          tax_lines?: Json | null
          tax_percent?: number | null
          tip_amount?: number | null
          trip_id: string
          updated_at?: string
          vendor_name?: string | null
        }
        Update: {
          ai_parsed?: boolean | null
          ai_parsed_data?: Json | null
          amount?: number
          base_currency_amount?: number | null
          booking_id?: string | null
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description?: string
          discount_amount?: number | null
          discount_percent?: number | null
          fx_rate?: number | null
          fx_rate_date?: string | null
          id?: string
          location?: string | null
          option_id?: string | null
          paid_by?: string
          parsing_error?: string | null
          participant_ids?: string[] | null
          payment_date?: string
          place_id?: string | null
          rate_source?: string | null
          receipt_date?: string | null
          receipt_url?: string | null
          rounding_adjustment?: number | null
          service_charge_amount?: number | null
          service_charge_percent?: number | null
          status?: Database["public"]["Enums"]["expense_status"] | null
          subtotal?: number | null
          tax_amount?: number | null
          tax_lines?: Json | null
          tax_percent?: number | null
          tip_amount?: number | null
          trip_id?: string
          updated_at?: string
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      fx_rates: {
        Row: {
          fetched_at: string | null
          from_currency: string
          id: string
          rate: number
          rate_date: string
          source: string | null
          to_currency: string
        }
        Insert: {
          fetched_at?: string | null
          from_currency: string
          id?: string
          rate: number
          rate_date: string
          source?: string | null
          to_currency: string
        }
        Update: {
          fetched_at?: string | null
          from_currency?: string
          id?: string
          rate?: number
          rate_date?: string
          source?: string | null
          to_currency?: string
        }
        Relationships: []
      }
      invitation_attempts: {
        Row: {
          code_attempted: string
          created_at: string | null
          id: string
          ip_address: unknown
          success: boolean | null
          user_agent: string | null
        }
        Insert: {
          code_attempted: string
          created_at?: string | null
          id?: string
          ip_address?: unknown
          success?: boolean | null
          user_agent?: string | null
        }
        Update: {
          code_attempted?: string
          created_at?: string | null
          id?: string
          ip_address?: unknown
          success?: boolean | null
          user_agent?: string | null
        }
        Relationships: []
      }
      invitations: {
        Row: {
          code: string
          created_at: string
          created_by: string
          current_uses: number
          expires_at: string | null
          id: string
          max_uses: number | null
          status: Database["public"]["Enums"]["invitation_status"] | null
          trip_id: string | null
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          code?: string
          created_at?: string
          created_by: string
          current_uses?: number
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          status?: Database["public"]["Enums"]["invitation_status"] | null
          trip_id?: string | null
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string
          current_uses?: number
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          status?: Database["public"]["Enums"]["invitation_status"] | null
          trip_id?: string | null
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invitations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_used_by_fkey"
            columns: ["used_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          channel: string
          dedupe_key: string
          entity_id: string | null
          entity_type: string | null
          id: string
          kind: string
          sent_at: string
          trip_id: string
          user_id: string
        }
        Insert: {
          channel?: string
          dedupe_key: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind: string
          sent_at?: string
          trip_id: string
          user_id: string
        }
        Update: {
          channel?: string
          dedupe_key?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          kind?: string
          sent_at?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      option_votes: {
        Row: {
          created_at: string
          id: string
          option_id: string
          rank: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          option_id: string
          rank?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          option_id?: string
          rank?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "option_votes_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "option_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      options: {
        Row: {
          created_at: string
          currency: string | null
          description: string | null
          id: string
          locked: boolean
          metadata: Json | null
          order_index: number
          place_id: string | null
          price: number | null
          price_type: Database["public"]["Enums"]["price_type"]
          section_id: string
          status: Database["public"]["Enums"]["option_status"]
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          description?: string | null
          id?: string
          locked?: boolean
          metadata?: Json | null
          order_index?: number
          place_id?: string | null
          price?: number | null
          price_type?: Database["public"]["Enums"]["price_type"]
          section_id: string
          status?: Database["public"]["Enums"]["option_status"]
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          description?: string | null
          id?: string
          locked?: boolean
          metadata?: Json | null
          order_index?: number
          place_id?: string | null
          price?: number | null
          price_type?: Database["public"]["Enums"]["price_type"]
          section_id?: string
          status?: Database["public"]["Enums"]["option_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "options_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "options_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "planning_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      places: {
        Row: {
          address: string | null
          created_at: string
          google_maps_link: string | null
          google_place_url: string | null
          id: string
          lat: number | null
          lng: number | null
          name: string
          source: string
          trip_id: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          google_maps_link?: string | null
          google_place_url?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          source?: string
          trip_id: string
        }
        Update: {
          address?: string | null
          created_at?: string
          google_maps_link?: string | null
          google_place_url?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          source?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "places_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      planning_sections: {
        Row: {
          allow_multiple_selections: boolean
          created_at: string
          description: string | null
          hide_votes_until_close: boolean
          id: string
          order_index: number
          quorum: number | null
          section_type: Database["public"]["Enums"]["section_type"]
          status: Database["public"]["Enums"]["section_status"]
          title: string
          trip_id: string
          updated_at: string
          vote_deadline: string | null
          voting_method: string
        }
        Insert: {
          allow_multiple_selections?: boolean
          created_at?: string
          description?: string | null
          hide_votes_until_close?: boolean
          id?: string
          order_index?: number
          quorum?: number | null
          section_type: Database["public"]["Enums"]["section_type"]
          status?: Database["public"]["Enums"]["section_status"]
          title: string
          trip_id: string
          updated_at?: string
          vote_deadline?: string | null
          voting_method?: string
        }
        Update: {
          allow_multiple_selections?: boolean
          created_at?: string
          description?: string | null
          hide_votes_until_close?: boolean
          id?: string
          order_index?: number
          quorum?: number | null
          section_type?: Database["public"]["Enums"]["section_type"]
          status?: Database["public"]["Enums"]["section_status"]
          title?: string
          trip_id?: string
          updated_at?: string
          vote_deadline?: string | null
          voting_method?: string
        }
        Relationships: [
          {
            foreignKeyName: "planning_sections_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          feature: string
          id: string
          last_refill: string
          tokens: number
          user_id: string
        }
        Insert: {
          feature: string
          id?: string
          last_refill?: string
          tokens: number
          user_id: string
        }
        Update: {
          feature?: string
          id?: string
          last_refill?: string
          tokens?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      reactions: {
        Row: {
          comment_id: string | null
          created_at: string
          emoji: string
          id: string
          option_id: string | null
          trip_id: string
          user_id: string
        }
        Insert: {
          comment_id?: string | null
          created_at?: string
          emoji: string
          id?: string
          option_id?: string | null
          trip_id: string
          user_id: string
        }
        Update: {
          comment_id?: string | null
          created_at?: string
          emoji?: string
          id?: string
          option_id?: string | null
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reactions_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reactions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      selections: {
        Row: {
          id: string
          metadata: Json | null
          option_id: string
          selected_at: string
          user_id: string
        }
        Insert: {
          id?: string
          metadata?: Json | null
          option_id: string
          selected_at?: string
          user_id: string
        }
        Update: {
          id?: string
          metadata?: Json | null
          option_id?: string
          selected_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "selections_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_carryovers: {
        Row: {
          amount: number
          created_at: string
          created_by: string
          currency: string
          from_user_id: string
          id: string
          source_trip_id: string
          to_user_id: string
          trip_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by: string
          currency: string
          from_user_id: string
          id?: string
          source_trip_id: string
          to_user_id: string
          trip_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string
          currency?: string
          from_user_id?: string
          id?: string
          source_trip_id?: string
          to_user_id?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_carryovers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_carryovers_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_carryovers_source_trip_id_fkey"
            columns: ["source_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_carryovers_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlement_carryovers_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      settlements: {
        Row: {
          amount: number
          created_at: string | null
          created_by: string
          currency: string | null
          from_user_id: string
          id: string
          notes: string | null
          payment_method: string | null
          settled_at: string
          status: string
          to_user_id: string
          trip_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          created_by: string
          currency?: string | null
          from_user_id: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at: string
          status?: string
          to_user_id: string
          trip_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          created_by?: string
          currency?: string | null
          from_user_id?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at?: string
          status?: string
          to_user_id?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlements_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlements_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlements_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_chat_messages: {
        Row: {
          actions_executed: Json | null
          content: string
          created_at: string | null
          had_write_actions: boolean | null
          id: string
          metadata: Json | null
          role: Database["public"]["Enums"]["chat_message_role"]
          trip_id: string
          user_id: string | null
        }
        Insert: {
          actions_executed?: Json | null
          content: string
          created_at?: string | null
          had_write_actions?: boolean | null
          id?: string
          metadata?: Json | null
          role: Database["public"]["Enums"]["chat_message_role"]
          trip_id: string
          user_id?: string | null
        }
        Update: {
          actions_executed?: Json | null
          content?: string
          created_at?: string | null
          had_write_actions?: boolean | null
          id?: string
          metadata?: Json | null
          role?: Database["public"]["Enums"]["chat_message_role"]
          trip_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_chat_messages_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_chat_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_checklists: {
        Row: {
          assigned_to: string | null
          created_at: string
          created_by: string
          done: boolean
          done_at: string | null
          id: string
          title: string
          trip_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          created_by: string
          done?: boolean
          done_at?: string | null
          id?: string
          title: string
          trip_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          created_by?: string
          done?: boolean
          done_at?: string | null
          id?: string
          title?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_checklists_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_checklists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_checklists_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_notes: {
        Row: {
          content: string
          created_at: string
          id: string
          note_type: Database["public"]["Enums"]["note_type"]
          trip_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          note_type?: Database["public"]["Enums"]["note_type"]
          trip_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          note_type?: Database["public"]["Enums"]["note_type"]
          trip_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_notes_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_notes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_participants: {
        Row: {
          active: boolean
          conditional_date: string | null
          conditional_type:
            | Database["public"]["Enums"]["conditional_type"]
            | null
          conditional_user_ids: string[] | null
          confirmation_note: string | null
          confirmation_status:
            | Database["public"]["Enums"]["confirmation_status"]
            | null
          confirmed_at: string | null
          created_at: string
          role: Database["public"]["Enums"]["participant_role"]
          trip_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          active?: boolean
          conditional_date?: string | null
          conditional_type?:
            | Database["public"]["Enums"]["conditional_type"]
            | null
          conditional_user_ids?: string[] | null
          confirmation_note?: string | null
          confirmation_status?:
            | Database["public"]["Enums"]["confirmation_status"]
            | null
          confirmed_at?: string | null
          created_at?: string
          role?: Database["public"]["Enums"]["participant_role"]
          trip_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          active?: boolean
          conditional_date?: string | null
          conditional_type?:
            | Database["public"]["Enums"]["conditional_type"]
            | null
          conditional_user_ids?: string[] | null
          confirmation_note?: string | null
          confirmation_status?:
            | Database["public"]["Enums"]["confirmation_status"]
            | null
          confirmed_at?: string | null
          created_at?: string
          role?: Database["public"]["Enums"]["participant_role"]
          trip_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_participants_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_timeline_events: {
        Row: {
          all_day: boolean | null
          category: Database["public"]["Enums"]["timeline_event_category"]
          created_at: string | null
          created_by: string
          description: string | null
          end_time: string | null
          event_date: string
          id: string
          location: string | null
          metadata: Json | null
          participant_ids: string[] | null
          place_id: string | null
          sort_order: number | null
          source_option_id: string | null
          start_time: string | null
          title: string
          trip_id: string
          updated_at: string | null
        }
        Insert: {
          all_day?: boolean | null
          category?: Database["public"]["Enums"]["timeline_event_category"]
          created_at?: string | null
          created_by: string
          description?: string | null
          end_time?: string | null
          event_date: string
          id?: string
          location?: string | null
          metadata?: Json | null
          participant_ids?: string[] | null
          place_id?: string | null
          sort_order?: number | null
          source_option_id?: string | null
          start_time?: string | null
          title: string
          trip_id: string
          updated_at?: string | null
        }
        Update: {
          all_day?: boolean | null
          category?: Database["public"]["Enums"]["timeline_event_category"]
          created_at?: string | null
          created_by?: string
          description?: string | null
          end_time?: string | null
          event_date?: string
          id?: string
          location?: string | null
          metadata?: Json | null
          participant_ids?: string[] | null
          place_id?: string | null
          sort_order?: number | null
          source_option_id?: string | null
          start_time?: string | null
          title?: string
          trip_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_timeline_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_timeline_events_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_timeline_events_source_option_id_fkey"
            columns: ["source_option_id"]
            isOneToOne: false
            referencedRelation: "options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_timeline_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          accommodation_cost_currency: string | null
          base_currency: string
          capacity_limit: number | null
          chase_settings: Json | null
          confirmation_deadline: string | null
          confirmation_enabled: boolean | null
          confirmation_message: string | null
          created_at: string
          created_by: string
          end_date: string
          estimated_accommodation_cost: number | null
          full_cost_link: string | null
          id: string
          is_public: boolean
          location: string
          name: string
          settlement_snapshot: Json | null
          settlement_snapshot_at: string | null
          settlement_snapshot_by: string | null
          start_date: string
          status: Database["public"]["Enums"]["trip_status"]
          updated_at: string
        }
        Insert: {
          accommodation_cost_currency?: string | null
          base_currency?: string
          capacity_limit?: number | null
          chase_settings?: Json | null
          confirmation_deadline?: string | null
          confirmation_enabled?: boolean | null
          confirmation_message?: string | null
          created_at?: string
          created_by: string
          end_date: string
          estimated_accommodation_cost?: number | null
          full_cost_link?: string | null
          id?: string
          is_public?: boolean
          location: string
          name: string
          settlement_snapshot?: Json | null
          settlement_snapshot_at?: string | null
          settlement_snapshot_by?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["trip_status"]
          updated_at?: string
        }
        Update: {
          accommodation_cost_currency?: string | null
          base_currency?: string
          capacity_limit?: number | null
          chase_settings?: Json | null
          confirmation_deadline?: string | null
          confirmation_enabled?: boolean | null
          confirmation_message?: string | null
          created_at?: string
          created_by?: string
          end_date?: string
          estimated_accommodation_cost?: number | null
          full_cost_link?: string | null
          id?: string
          is_public?: boolean
          location?: string
          name?: string
          settlement_snapshot?: Json | null
          settlement_snapshot_at?: string | null
          settlement_snapshot_by?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["trip_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_settlement_snapshot_by_fkey"
            columns: ["settlement_snapshot_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_data: Json | null
          avatar_url: string | null
          created_at: string
          email: string
          email_notifications_enabled: boolean
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          payment_details: Json | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_data?: Json | null
          avatar_url?: string | null
          created_at?: string
          email: string
          email_notifications_enabled?: boolean
          first_name?: string | null
          full_name?: string | null
          id: string
          last_name?: string | null
          payment_details?: Json | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_data?: Json | null
          avatar_url?: string | null
          created_at?: string
          email?: string
          email_notifications_enabled?: boolean
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          payment_details?: Json | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      assign_user_to_trip: {
        Args: { p_invitation_id: string; p_user_id: string }
        Returns: boolean
      }
      can_view_trip: {
        Args: { p_trip_id: string; p_user_id: string }
        Returns: boolean
      }
      check_all_items_claimed: {
        Args: { p_expense_id: string }
        Returns: boolean
      }
      check_conditions_met: {
        Args: { p_trip_id: string; p_user_id: string }
        Returns: boolean
      }
      cleanup_expired_invitations: { Args: never; Returns: number }
      consume_rate_limit: {
        Args: {
          p_capacity: number
          p_feature: string
          p_refill_per_day: number
        }
        Returns: boolean
      }
      create_invitation: {
        Args: { p_expires_at: string; p_trip_id: string }
        Returns: {
          code: string
          created_at: string
          created_by: string
          expires_at: string
          id: string
          trip_id: string
        }[]
      }
      create_trip_with_participant: {
        Args: {
          p_end_date: string
          p_is_public?: boolean
          p_location: string
          p_name: string
          p_start_date: string
          p_status: Database["public"]["Enums"]["trip_status"]
        }
        Returns: string
      }
      generate_invitation_code: { Args: never; Returns: string }
      get_confirmation_summary: {
        Args: { p_trip_id: string }
        Returns: {
          count: number
          status: Database["public"]["Enums"]["confirmation_status"]
          user_ids: string[]
        }[]
      }
      get_confirmed_count: { Args: { p_trip_id: string }; Returns: number }
      get_recent_failed_attempts: {
        Args: { hours_back?: number }
        Returns: {
          attempt_count: number
          code_attempted: string
          ip_addresses: string[]
          last_attempt: string
        }[]
      }
      is_trip_organizer: {
        Args: { p_trip_id: string; p_user_id: string }
        Returns: boolean
      }
      is_trip_participant: {
        Args: { p_trip_id: string; p_user_id: string }
        Returns: boolean
      }
      mark_invitation_used: {
        Args: { p_invitation_id: string; p_user_id: string }
        Returns: boolean
      }
      update_invitation_on_confirm: {
        Args: { p_user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      chat_message_role: "user" | "assistant" | "system"
      conditional_type: "none" | "date" | "users" | "both"
      confirmation_status:
        | "pending"
        | "confirmed"
        | "interested"
        | "conditional"
        | "waitlist"
        | "declined"
        | "cancelled"
      expense_category:
        | "accommodation"
        | "transport"
        | "food"
        | "activities"
        | "equipment"
        | "other"
      expense_status:
        | "unallocated"
        | "pending_allocation"
        | "allocated"
        | "confirmed"
      invitation_status:
        | "active"
        | "pending_verification"
        | "completed"
        | "expired"
      note_type: "announcement" | "note" | "reminder" | "question" | "info"
      option_status: "draft" | "available" | "booking" | "booked" | "cancelled"
      participant_role: "organizer" | "participant"
      price_type: "per_person_fixed" | "total_split" | "per_person_tiered"
      section_status: "not_started" | "in_progress" | "completed"
      section_type:
        | "accommodation"
        | "flights"
        | "transport"
        | "equipment"
        | "insurance"
        | "activities"
        | "lessons"
      split_type: "equal" | "custom" | "percentage" | "shares"
      timeline_event_category:
        | "flight"
        | "accommodation"
        | "transport"
        | "activity"
        | "dining"
        | "transfer"
        | "meeting_point"
        | "free_time"
        | "other"
      trip_status:
        | "gathering_interest"
        | "confirming_participants"
        | "booking_details"
        | "booked_awaiting_departure"
        | "trip_ongoing"
        | "trip_completed"
      user_role: "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      chat_message_role: ["user", "assistant", "system"],
      conditional_type: ["none", "date", "users", "both"],
      confirmation_status: [
        "pending",
        "confirmed",
        "interested",
        "conditional",
        "waitlist",
        "declined",
        "cancelled",
      ],
      expense_category: [
        "accommodation",
        "transport",
        "food",
        "activities",
        "equipment",
        "other",
      ],
      expense_status: [
        "unallocated",
        "pending_allocation",
        "allocated",
        "confirmed",
      ],
      invitation_status: [
        "active",
        "pending_verification",
        "completed",
        "expired",
      ],
      note_type: ["announcement", "note", "reminder", "question", "info"],
      option_status: ["draft", "available", "booking", "booked", "cancelled"],
      participant_role: ["organizer", "participant"],
      price_type: ["per_person_fixed", "total_split", "per_person_tiered"],
      section_status: ["not_started", "in_progress", "completed"],
      section_type: [
        "accommodation",
        "flights",
        "transport",
        "equipment",
        "insurance",
        "activities",
        "lessons",
      ],
      split_type: ["equal", "custom", "percentage", "shares"],
      timeline_event_category: [
        "flight",
        "accommodation",
        "transport",
        "activity",
        "dining",
        "transfer",
        "meeting_point",
        "free_time",
        "other",
      ],
      trip_status: [
        "gathering_interest",
        "confirming_participants",
        "booking_details",
        "booked_awaiting_departure",
        "trip_ongoing",
        "trip_completed",
      ],
      user_role: ["admin", "member"],
    },
  },
} as const
