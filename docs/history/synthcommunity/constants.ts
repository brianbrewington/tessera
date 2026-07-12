import { PersonaType } from './types';

export const INITIAL_QUESTIONS = [
  "How would your friends describe you?",
  "Tell about a time you were working or at school and totally lost track of time. What were you doing? What was it like?",
  "What is a specific new thing or skill you are learning about these days? How are you learning it? What does it make you curious about, to dig into next?",
  "Who is a historical figure you admire, and why?",
  "Tell about something you made. What did you make, and what did you like about it? What would you make differently if you did it again?",
  "Tell about something you are hopeful for, and why?",
  "What is a piece of artwork (any type) that you've found inspirational or moving? How?",
  "What's a hobby you enjoy? Why?",
  "What is a specific thing you've read recently that impacted you? What was that impact?",
  "What's a life decision you regret? What happened?",
  "What is a nonprofit or organization that you support or follow? How does it inspire you?",
  "Describe a specific project you are currently obsessed with or burning to start. What is the detailed 'next step' you need to take?",
  "Tell about a time you had to learn something difficult very quickly to solve a real-world problem. What specifically did you do to master it?",
  "What would constitute a perfect day for you?",
  "For what in your life do you feel most grateful?",
  "At school, what was an experience you loved?",
  "Think of a day at work or school when, as you headed home, you might have said to yourself, “I would have done that for free.” What happened that day to make you say that?",
  "Think of a good friend in your life. What do you value most in your friendship with them?",
  "Recall a major life decision. What was at stake? How did you choose?",
  "What is something specific you find discouraging? What helps you keep this from overwhelming your hope?",
  "What is a trait of yours that is sometimes a great strength but can also be a crippling weakness?",
  "If you knew that in one year you would die suddenly, what would you change about how you are living?",
  "Think of your worst day at work or school—the kind of day you hope never to go through again. What happened?",
  "What is the earliest, specific, happy childhood memory that comes to your mind?",
  "What has been a pivotal moment in your life, one when you realized nothing would ever be the same?",
  "What was a time when you gave of yourself to help someone else, after which you felt unbelievably good—like you had done something that mattered?"
];

export const DEFAULT_DISTRIBUTION: Record<PersonaType, number> = {
  [PersonaType.GlobalYouth]: 10,
  [PersonaType.AmericanCollegeStudent]: 60,
  [PersonaType.Technologist]: 3,
  [PersonaType.SocialEntrepreneur]: 5,
  [PersonaType.ImpactInvestor]: 3,
  [PersonaType.ConsciousPhilanthropist]: 3,
  [PersonaType.Artist]: 3,
  [PersonaType.Scholar]: 9,
  [PersonaType.Intuitive]: 2,
  [PersonaType.Leader]: 2
};

export const SCOPES = 'https://www.googleapis.com/auth/drive.file';
export const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];

// Used to force entropy in generation
export const COUNTRY_LIST = [
  "Argentina", "Australia", "Austria", "Bangladesh", "Belgium", "Bolivia", "Botswana", "Brazil", "Bulgaria", "Cambodia", 
  "Cameroon", "Canada", "Chile", "China", "Colombia", "Costa Rica", "Croatia", "Czech Republic", "Denmark", "Dominican Republic", 
  "Ecuador", "Egypt", "Estonia", "Ethiopia", "Finland", "France", "Germany", "Ghana", "Greece", "Guatemala", "Honduras", 
  "Hungary", "Iceland", "India", "Indonesia", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kenya", 
  "Latvia", "Lebanon", "Lithuania", "Malaysia", "Mexico", "Mongolia", "Morocco", "Namibia", "Nepal", "Netherlands", 
  "New Zealand", "Nigeria", "Norway", "Pakistan", "Panama", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", 
  "Romania", "Rwanda", "Senegal", "Serbia", "Singapore", "Slovakia", "Slovenia", "South Africa", "South Korea", "Spain", 
  "Sri Lanka", "Sweden", "Switzerland", "Taiwan", "Tanzania", "Thailand", "Tunisia", "Turkey", "Uganda", "Ukraine", 
  "United Kingdom", "United States", "Uruguay", "Vietnam", "Zambia", "Zimbabwe"
];