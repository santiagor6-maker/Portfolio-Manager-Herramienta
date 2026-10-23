/**
 * W43: CNPJ of common B3 issuers by root ticker, to prefill "Bens e Direitos" beyond the nine in
 * @pm/tax's own table (PETR, VALE, ITUB, BBDC, BBAS, ABEV, ITSA, B3SA, WEGE). Public registry data
 * (Receita Federal / the companies' investor-relations pages, checked 2026-10); the user must still
 * confirm each one against the broker's informe de rendimentos.
 */
export const B3_CNPJ_EXTRA: Record<string, string> = {
  ALUP: '08.364.948/0001-38', // Alupar
  ASAI: '06.057.223/0001-71', // Assaí
  AURE: '28.594.234/0001-23', // Auren Energia
  BBSE: '17.344.597/0001-94', // BB Seguridade
  BPAC: '30.306.294/0001-45', // BTG Pactual
  BRAP: '03.847.461/0001-92', // Bradespar
  BRFS: '01.838.723/0001-27', // BRF
  CCRO: '02.846.056/0001-97', // CCR (Motiva)
  MOTV: '02.846.056/0001-97', // Motiva (antes CCR)
  CMIG: '17.155.730/0001-64', // Cemig
  CMIN: '08.902.291/0001-15', // CSN Mineração
  CPFE: '02.429.144/0001-93', // CPFL Energia
  CPLE: '76.483.817/0001-20', // Copel
  CSAN: '50.746.577/0001-15', // Cosan
  CSMG: '17.281.106/0001-03', // Copasa
  CSNA: '33.042.730/0001-04', // Companhia Siderúrgica Nacional
  CXSE: '22.543.331/0001-00', // Caixa Seguridade
  CYRE: '73.178.600/0001-18', // Cyrela
  EGIE: '02.474.103/0001-19', // Engie Brasil
  ELET: '00.001.180/0001-26', // Eletrobras
  EMBR: '07.689.002/0001-89', // Embraer
  EMBJ: '07.689.002/0001-89', // Embraer (código novo)
  ENEV: '04.423.567/0001-21', // Eneva
  EQTL: '03.220.438/0001-73', // Equatorial
  FLRY: '60.840.055/0001-31', // Fleury
  GGBR: '33.611.500/0001-19', // Gerdau
  GOAU: '92.690.783/0001-09', // Metalúrgica Gerdau
  JBSS: '02.916.265/0001-60', // JBS
  KLBN: '89.637.490/0001-45', // Klabin
  LREN: '92.754.738/0001-62', // Lojas Renner
  MGLU: '47.960.950/0001-21', // Magazine Luiza
  MULT: '07.816.890/0001-53', // Multiplan
  PRIO: '10.629.105/0001-68', // PRIO
  PSSA: '02.149.205/0001-69', // Porto Seguro
  RADL: '61.585.865/0001-51', // Raia Drogasil
  RAIL: '02.387.241/0001-60', // Rumo
  RENT: '16.670.085/0001-55', // Localiza
  SANB: '90.400.888/0001-42', // Santander Brasil
  SAPR: '76.484.013/0001-45', // Sanepar
  SBSP: '43.776.517/0001-80', // Sabesp
  SMTO: '51.466.860/0001-56', // São Martinho
  SUZB: '16.404.287/0001-55', // Suzano
  TAEE: '07.859.971/0001-30', // Taesa
  TIMS: '02.421.421/0001-11', // TIM
  TOTS: '53.113.791/0001-22', // Totvs
  TRPL: '02.998.611/0001-04', // ISA CTEEP
  ISAE: '02.998.611/0001-04', // ISA Energia Brasil (antes ISA CTEEP)
  UGPA: '33.256.439/0001-39', // Ultrapar
  USIM: '60.894.730/0001-05', // Usiminas
  VBBR: '34.274.233/0001-02', // Vibra Energia
  VIVT: '02.558.157/0001-62', // Telefônica Brasil
};
