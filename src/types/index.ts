// User Types
export interface User {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  profilePicture?: string;
  isVerified: boolean;
  isActive: boolean;
  role: 'user' | 'host' | 'admin';
  kycStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  data: {
    user: User;
    token: string;
  };
}

// Location Types
export interface Location {
  address: string;
  city: string;
  state: string;
  country: string;
  zipCode: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
}

// Listing Types
export interface Listing {
  _id: string;
  host: User;
  title: string;
  description: string;
  propertyType: string;
  roomType: string;
  accommodates: number;
  bedrooms: number;
  bathrooms: number;
  price: number;
  currency: string;
  location: Location;
  amenities: string[];
  photos: string[];
  houseRules: string[];
  availability: Availability[];
  status: 'active' | 'inactive' | 'pending';
  rating?: number;
  reviewCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Availability {
  startDate: string;
  endDate: string;
  isAvailable: boolean;
}

// Booking Types
export interface Booking {
  _id: string;
  guest: User;
  listing: Listing;
  checkIn: string;
  checkOut: string;
  guests: number;
  totalAmount: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  specialRequests?: string;
  paymentStatus: 'pending' | 'paid' | 'refunded' | 'partially_refunded' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

// Review Types
export interface Review {
  _id: string;
  guest: User;
  listing: Listing;
  booking: string;
  rating: number;
  comment: string;
  cleanliness: number;
  accuracy: number;
  communication: number;
  location: number;
  checkIn: number;
  value: number;
  hostResponse?: string;
  createdAt: string;
  updatedAt: string;
}

// Payment Types
export interface Payment {
  _id: string;
  booking: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
}

// Service Types
export interface Service {
  _id: string;
  provider: User;
  title: string;
  description: string;
  category: string;
  price: number;
  currency: string;
  location: Location;
  availability: Availability[];
  status: 'active' | 'inactive' | 'pending';
  rating?: number;
  reviewCount?: number;
  createdAt: string;
  updatedAt: string;
}

// Support Types
export interface SupportTicket {
  _id: string;
  user: User;
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  category: string;
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface TicketMessage {
  _id: string;
  user: User;
  message: string;
  createdAt: string;
}

// Notification Types
export interface Notification {
  _id: string;
  user: string;
  title: string;
  message: string;
  type: 'booking' | 'payment' | 'review' | 'support' | 'system';
  isRead: boolean;
  relatedId?: string;
  createdAt: string;
}

// Wishlist Types
export interface Wishlist {
  _id: string;
  user: string;
  name: string;
  items: WishlistItem[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WishlistItem {
  _id: string;
  type: 'listing' | 'service';
  itemId: string;
  addedAt: string;
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  message: string;
  data: {
    items: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// Form Types
export interface LoginForm {
  email: string;
  password: string;
}

export interface RegisterForm {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
}

export interface ListingForm {
  title: string;
  description: string;
  propertyType: string;
  roomType: string;
  accommodates: number;
  bedrooms: number;
  bathrooms: number;
  price: number;
  currency: string;
  location: Location;
  amenities: string[];
  houseRules: string[];
}

export interface BookingForm {
  listingId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  specialRequests?: string;
}

export interface ReviewForm {
  bookingId: string;
  rating: number;
  comment: string;
  cleanliness: number;
  accuracy: number;
  communication: number;
  location: number;
  checkIn: number;
  value: number;
}

// Search Types
export interface SearchFilters {
  location?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  minPrice?: number;
  maxPrice?: number;
  propertyType?: string;
  amenities?: string[];
  page?: number;
  limit?: number;
} 
