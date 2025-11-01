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
  public: {
    Tables: {
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
      expense_splits: {
        Row: {
          amount: number
          base_currency_amount: number | null
          created_at: string
          expense_id: string
          id: string
          percentage: number | null
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
          ai_parsed_data: Json | null
          amount: number
          base_currency_amount: number | null
          category: Database["public"]["Enums"]["expense_category"]
          created_at: string
          currency: string
          description: string
          fx_rate: number | null
          fx_rate_date: string | null
          id: string
          location: string | null
          paid_by: string
          payment_date: string
          receipt_url: string | null
          trip_id: string
          updated_at: string
          vendor_name: string | null
        }
        Insert: {
          ai_parsed_data?: Json | null
          amount: number
          base_currency_amount?: number | null
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description: string
          fx_rate?: number | null
          fx_rate_date?: string | null
          id?: string
          location?: string | null
          paid_by: string
          payment_date?: string
          receipt_url?: string | null
          trip_id: string
          updated_at?: string
          vendor_name?: string | null
        }
        Update: {
          ai_parsed_data?: Json | null
          amount?: number
          base_currency_amount?: number | null
          category?: Database["public"]["Enums"]["expense_category"]
          created_at?: string
          currency?: string
          description?: string
          fx_rate?: number | null
          fx_rate_date?: string | null
          id?: string
          location?: string | null
          paid_by?: string
          payment_date?: string
          receipt_url?: string | null
          trip_id?: string
          updated_at?: string
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "users"
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
      options: {
        Row: {
          created_at: string
          currency: string | null
          description: string | null
          id: string
          locked: boolean
          metadata: Json | null
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
          price?: number | null
          price_type?: Database["public"]["Enums"]["price_type"]
          section_id?: string
          status?: Database["public"]["Enums"]["option_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "options_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "planning_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      planning_sections: {
        Row: {
          allow_multiple_selections: boolean
          created_at: string
          description: string | null
          id: string
          order_index: number
          section_type: Database["public"]["Enums"]["section_type"]
          status: Database["public"]["Enums"]["section_status"]
          title: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          allow_multiple_selections?: boolean
          created_at?: string
          description?: string | null
          id?: string
          order_index?: number
          section_type: Database["public"]["Enums"]["section_type"]
          status?: Database["public"]["Enums"]["section_status"]
          title: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          allow_multiple_selections?: boolean
          created_at?: string
          description?: string | null
          id?: string
          order_index?: number
          section_type?: Database["public"]["Enums"]["section_type"]
          status?: Database["public"]["Enums"]["section_status"]
          title?: string
          trip_id?: string
          updated_at?: string
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
      settlements: {
        Row: {
          amount: number
          created_at: string | null
          created_by: string
          from_user_id: string
          id: string
          notes: string | null
          payment_method: string | null
          settled_at: string
          to_user_id: string
          trip_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          created_by: string
          from_user_id: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at: string
          to_user_id: string
          trip_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          created_by?: string
          from_user_id?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at?: string
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
          created_at: string
          role: Database["public"]["Enums"]["participant_role"]
          trip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role?: Database["public"]["Enums"]["participant_role"]
          trip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: Database["public"]["Enums"]["participant_role"]
          trip_id?: string
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
      trips: {
        Row: {
          created_at: string
          created_by: string
          end_date: string
          id: string
          location: string
          name: string
          start_date: string
          status: Database["public"]["Enums"]["trip_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          end_date: string
          id?: string
          location: string
          name: string
          start_date: string
          status?: Database["public"]["Enums"]["trip_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          end_date?: string
          id?: string
          location?: string
          name?: string
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
        ]
      }
      users: {
        Row: {
          avatar_data: Json | null
          avatar_url: string | null
          created_at: string
          email: string
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_data?: Json | null
          avatar_url?: string | null
          created_at?: string
          email: string
          first_name?: string | null
          full_name?: string | null
          id: string
          last_name?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_data?: Json | null
          avatar_url?: string | null
          created_at?: string
          email?: string
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
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
      cleanup_expired_invitations: { Args: Record<PropertyKey, never>; Returns: number }
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
          p_location: string
          p_name: string
          p_start_date: string
          p_status: Database["public"]["Enums"]["trip_status"]
        }
        Returns: string
      }
      generate_invitation_code: { Args: Record<PropertyKey, never>; Returns: string }
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
      expense_category:
        | "accommodation"
        | "transport"
        | "food"
        | "activities"
        | "equipment"
        | "other"
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
      split_type: "equal" | "custom" | "percentage"
      trip_status: "planning" | "booking" | "booked"
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
  public: {
    Enums: {
      expense_category: [
        "accommodation",
        "transport",
        "food",
        "activities",
        "equipment",
        "other",
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
      split_type: ["equal", "custom", "percentage"],
      trip_status: ["planning", "booking", "booked"],
      user_role: ["admin", "member"],
    },
  },
} as const
