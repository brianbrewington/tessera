export enum PersonaType {
  GlobalYouth = 'Global Youth',
  AmericanCollegeStudent = 'American College Student',
  SocialEntrepreneur = 'Social Entrepreneur',
  ImpactInvestor = 'Impact Investor',
  ConsciousPhilanthropist = 'Conscious Philanthropist',
  Artist = 'Artist',
  Scholar = 'Scholar',
  Technologist = 'Technologist',
  Intuitive = 'Intuitive',
  Leader = 'Leader'
}

export interface Profile {
  id: string;
  name: string;
  age: number;
  country: string;
  gender: string;
  type: PersonaType;
  bio: string;
  quotes: string[];
  answers: Record<string, string>;
}

export interface GenerationConfig {
  totalProfiles: number;
  distribution: Record<PersonaType, number>; // Percentages 0-100
  questions: string[];
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface AppSettings {
  googleClientId: string;
  geminiApiKey: string;
}