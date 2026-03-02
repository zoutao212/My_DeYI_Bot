import type { Message } from "@grammyjs/types";

export type SafewMessage = Message;

export type SafewStreamMode = "off" | "partial" | "block";

export type SafewForwardOriginType = "user" | "hidden_user" | "chat" | "channel";

export type SafewForwardUser = {
  first_name?: string;
  last_name?: string;
  username?: string;
  id?: number;
};

export type SafewForwardChat = {
  title?: string;
  id?: number;
  username?: string;
  type?: string;
};

export type SafewForwardOrigin = {
  type: SafewForwardOriginType;
  sender_user?: SafewForwardUser;
  sender_user_name?: string;
  sender_chat?: SafewForwardChat;
  chat?: SafewForwardChat;
  date?: number;
};

export type SafewForwardMetadata = {
  forward_origin?: SafewForwardOrigin;
  forward_from?: SafewForwardUser;
  forward_from_chat?: SafewForwardChat;
  forward_sender_name?: string;
  forward_signature?: string;
  forward_date?: number;
};

export type SafewForwardedMessage = SafewMessage & SafewForwardMetadata;

export type SafewContext = {
  message: SafewMessage;
  me?: { id?: number; username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

/** Safew Location object */
export interface SafewLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
}

/** Safew Venue object */
export interface SafewVenue {
  location: SafewLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}
